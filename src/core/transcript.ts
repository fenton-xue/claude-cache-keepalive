import type { UserRecord } from './types';

/**
 * 解析会话记录里的一行。只关心 user 记录，其余（含子代理侧链）返回 null。
 * 侧链记录属于子代理的独立上下文，不刷新主会话的缓存。
 */
export function parseUserRecord(line: string): UserRecord | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const r = o as Record<string, unknown>;
  if (r.type !== 'user' || r.isSidechain === true) return null;
  const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  if (Number.isNaN(ts)) return null;

  const message = r.message as { content?: unknown } | undefined;
  const content = message?.content;
  const isToolResult =
    Array.isArray(content) &&
    content.some((c) => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'tool_result');

  const origin = r.origin as { kind?: unknown; msg_id?: unknown } | undefined;
  const rec: UserRecord = { timestamp: ts, isToolResult, isMeta: r.isMeta === true };
  if (origin && typeof origin.kind === 'string') rec.originKind = origin.kind;
  if (origin && typeof origin.msg_id === 'string') rec.originMsgId = origin.msg_id;
  return rec;
}

/** 解析多行文本里的全部 user 记录 */
export function parseUserRecords(text: string): UserRecord[] {
  const out: UserRecord[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const rec = parseUserRecord(line);
    if (rec) out.push(rec);
  }
  return out;
}
