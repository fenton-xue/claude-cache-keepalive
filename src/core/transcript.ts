import type { UserRecord } from './types';

/** 会话记录里本程序关心的两类记录 */
export type TxRecord = ({ kind: 'user' } & UserRecord) | { kind: 'assistant'; timestamp: number };

function baseOf(line: string): { r: Record<string, unknown>; ts: number } | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const r = o as Record<string, unknown>;
  // 子代理侧链是独立的上下文，不刷新主会话的缓存
  if (r.isSidechain === true) return null;
  const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  return Number.isNaN(ts) ? null : { r, ts };
}

/**
 * 解析会话记录里的一行。只关心 user 和 assistant 记录，其余返回 null。
 * API 报错生成的合成 assistant 记录（isApiErrorMessage）不是一次成功的响应，忽略。
 */
export function parseRecord(line: string): TxRecord | null {
  const b = baseOf(line);
  if (!b) return null;
  const { r, ts } = b;
  if (r.type === 'assistant') {
    return r.isApiErrorMessage === true ? null : { kind: 'assistant', timestamp: ts };
  }
  if (r.type !== 'user') return null;

  const message = r.message as { content?: unknown } | undefined;
  const content = message?.content;
  const isToolResult =
    Array.isArray(content) &&
    content.some((c) => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'tool_result');

  const origin = r.origin as { kind?: unknown; msg_id?: unknown } | undefined;
  const rec: TxRecord = { kind: 'user', timestamp: ts, isToolResult, isMeta: r.isMeta === true };
  if (origin && typeof origin.kind === 'string') rec.originKind = origin.kind;
  if (origin && typeof origin.msg_id === 'string') rec.originMsgId = origin.msg_id;
  return rec;
}

/** 只要 user 记录（新请求识别用） */
export function parseUserRecord(line: string): UserRecord | null {
  const rec = parseRecord(line);
  if (!rec || rec.kind !== 'user') return null;
  const { kind: _k, ...user } = rec;
  return user;
}

/** 多行文本里的全部 user 记录 */
export function parseUserRecords(text: string): UserRecord[] {
  const out: UserRecord[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const rec = parseUserRecord(line);
    if (rec) out.push(rec);
  }
  return out;
}

/** 这条 user 记录写入时，是否意味着一次 API 请求已经发出 */
function startsRequest(r: UserRecord): boolean {
  if (r.isToolResult) return false; // 并行工具要等全部返回才发请求，单条结果不代表请求已发出
  if (r.isMeta && r.originKind !== 'peer') return false; // 技能内容等系统伴随记录
  return true;
}

/**
 * “最后一次 API 请求发起时间”。按文件顺序喂入 user / assistant 记录：
 * - 连续的 user 记录之后出现 assistant 回复，说明这一串之后发出了请求，请求时间取这一串里的最后一条
 *   （并行工具先返回的结果不算：请求要等最后一个结果到齐才发出）；
 * - 文件末尾还没有回复的 user 记录：若是人工输入或 peer 消息，请求已经发出，按它算；
 *   若是工具返回，可能还在等其他并行工具，暂不计入。
 */
export class RequestTracker {
  private confirmed: number | null = null;
  private open: UserRecord | null = null;

  feed(rec: TxRecord): void {
    if (rec.kind === 'user') {
      this.open = rec;
    } else if (this.open) {
      this.confirmed = this.confirmed === null ? this.open.timestamp : Math.max(this.confirmed, this.open.timestamp);
      this.open = null;
    }
  }

  get(): number | null {
    const trailing = this.open && startsRequest(this.open) ? this.open.timestamp : null;
    if (trailing === null) return this.confirmed;
    return this.confirmed === null ? trailing : Math.max(this.confirmed, trailing);
  }
}
