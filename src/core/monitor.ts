import { describeFailure, type SendResult } from './format';
import { CACHE_TTL_MS, SEND_TIMEOUT_MS, STALL_WARN_MS, streakCap } from './settings';
import { displayName, findBySessionId, isAvailable } from './sessions';
import type {
  Clock,
  Notice,
  RegistryEntry,
  SendReceipt,
  Sender,
  SessionRegistry,
  SystemProbe,
  TranscriptSource,
  UserRecord,
} from './types';

export type Mode = 'watching' | 'sending' | 'expired' | 'failed' | 'capped' | 'gone';

export interface MonitorState {
  sessionId: string;
  name: string;
  mode: Mode;
  /** 已完成勾选时的基线读取 */
  ready: boolean;
  /** 连续成功发送次数 */
  streak: number;
  /** 最后一次请求时间（毫秒）；ready 之前为 null */
  lastRequestAt: number | null;
  lastResult: SendResult | null;
  /** 仅 gone：给行内显示的说明 */
  note?: string;
  /** 已发出、等待判定的消息 */
  pending: { msgId: string; sentAt: number; matched: boolean } | null;
  /** 本轮忙碌已经提醒过“缓存即将失效”；有新请求或会话回到空闲后清除 */
  stallWarned: boolean;
}

export interface MonitorDeps {
  clock: Clock;
  registry: SessionRegistry;
  probe: SystemProbe;
  transcripts: TranscriptSource;
  sender: Sender;
  getSettings: () => { content: string; intervalSec: number };
  notify: (n: Notice) => void;
  /** 任何状态变化后调用，宿主据此推送界面 */
  onChange?: () => void;
}

const RECEIPT_KEEP = 200;

export class Monitor {
  private readonly map = new Map<string, MonitorState>();
  /** 本程序发送过的全部 msgId，用来把自己的消息从“新请求”里排除 */
  private readonly sentIds = new Set<string>();
  private readonly receipts = new Map<string, SendReceipt>();
  /** 发送调用进行中时收到的记录，等 pending 建立后再处理 */
  private readonly deferred = new WeakMap<MonitorState, UserRecord[]>();
  private ticking = false;

  constructor(private readonly deps: MonitorDeps) {}

  states(): readonly MonitorState[] {
    return [...this.map.values()];
  }

  get(sessionId: string): MonitorState | undefined {
    return this.map.get(sessionId);
  }

  /** 正在监控（含已过期、失败、达上限等，勾选仍保留的状态） */
  isChecked(sessionId: string): boolean {
    const s = this.map.get(sessionId);
    return s !== undefined && s.mode !== 'gone';
  }

  /** 勾选。会话不可用时返回 false。重复勾选等于重新开始（次数归零）。 */
  async check(sessionId: string): Promise<boolean> {
    const entries = await this.deps.registry.list();
    const entry = findBySessionId(entries, sessionId, this.deps.probe);
    if (!entry || !isAvailable(entry, this.deps.probe)) return false;

    this.deps.transcripts.forget(sessionId);
    const s: MonitorState = {
      sessionId,
      name: displayName(entry),
      mode: 'watching',
      ready: false,
      streak: 0,
      lastRequestAt: null,
      lastResult: null,
      pending: null,
      stallWarned: false,
    };
    this.map.set(sessionId, s);
    this.changed();

    let poll;
    try {
      poll = await this.deps.transcripts.poll(sessionId);
    } catch {
      poll = undefined;
    }
    if (this.map.get(sessionId) !== s) return true; // 期间被取消或重新勾选
    s.lastRequestAt = poll?.lastRequestAt ?? entry.statusUpdatedAt ?? this.deps.clock.now();
    s.ready = true;
    // 忙碌时不判断过期，等变为 idle 后由 tick 判断
    if (isIdle(entry) && this.deps.clock.now() - s.lastRequestAt > CACHE_TTL_MS) s.mode = 'expired';
    this.changed();
    return true;
  }

  /** 取消勾选：立即停止监控，倒计时、次数和结果全部清空 */
  uncheck(sessionId: string): void {
    this.deps.transcripts.forget(sessionId);
    if (this.map.delete(sessionId)) this.changed();
  }

  stopAll(): void {
    for (const id of [...this.map.keys()]) this.deps.transcripts.forget(id);
    this.map.clear();
    this.changed();
  }

  /** 清掉“会话已退出”的提示（手动刷新时调用） */
  clearGone(): void {
    let any = false;
    for (const [id, s] of this.map) {
      if (s.mode === 'gone') {
        this.map.delete(id);
        any = true;
      }
    }
    if (any) this.changed();
  }

  /** 已过期的会话经用户确认后立即发送 */
  async confirm(sessionId: string): Promise<void> {
    const s = this.map.get(sessionId);
    if (!s || s.mode !== 'expired') return;
    const entries = await this.deps.registry.list();
    const entry = findBySessionId(entries, sessionId, this.deps.probe);
    if (this.map.get(sessionId) !== s || s.mode !== 'expired') return;
    if (!entry || !isAvailable(entry, this.deps.probe)) {
      this.markGone(s);
      return;
    }
    await this.beginSend(s, entry);
  }

  /** 宿主把 cc-peer 收到的回执原样交进来；与本程序无关的回执忽略 */
  onReceipt(r: SendReceipt): void {
    // 回执可能先于 send() 的返回到达，这里不按 msgId 过滤，只限制总量
    this.receipts.set(r.origMsgId, r);
    if (this.receipts.size > RECEIPT_KEEP) {
      const oldest = this.receipts.keys().next().value;
      if (oldest !== undefined) this.receipts.delete(oldest);
    }
  }

  /** 宿主定时（约每秒）调用。单个会话出错不影响其他会话。 */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let entries: RegistryEntry[];
      try {
        entries = await this.deps.registry.list();
      } catch {
        return;
      }
      await Promise.all(
        [...this.map.values()].map((s) => this.tickOne(s, entries).catch(() => undefined)),
      );
    } finally {
      this.ticking = false;
    }
  }

  // ---------------------------------------------------------------- 内部

  private async tickOne(s: MonitorState, entries: RegistryEntry[]): Promise<void> {
    if (s.mode === 'gone' || !s.ready) return;
    if (s.mode === 'sending' && !s.pending) return; // send() 调用还没返回

    const entry = findBySessionId(entries, s.sessionId, this.deps.probe);
    if (!entry || !isAvailable(entry, this.deps.probe)) {
      this.markGone(s);
      return;
    }
    if (displayName(entry) !== s.name) {
      s.name = displayName(entry);
      this.changed();
    }

    const poll = await this.deps.transcripts.poll(s.sessionId);
    if (this.map.get(s.sessionId) !== s || modeOf(s) === 'gone') return;
    if (poll) {
      this.absorb(s, poll.appended);
      if (poll.lastRequestAt !== null && (s.lastRequestAt === null || poll.lastRequestAt > s.lastRequestAt)) {
        s.lastRequestAt = poll.lastRequestAt;
        s.stallWarned = false;
      }
    } else if (entry.statusUpdatedAt !== undefined && entry.statusUpdatedAt > (s.lastRequestAt ?? 0)) {
      s.lastRequestAt = entry.statusUpdatedAt; // 记录文件读不到时的退路
    }

    const now = this.deps.clock.now();
    switch (s.mode) {
      case 'sending':
        this.resolvePending(s, now);
        return;
      case 'expired':
        if (s.lastRequestAt !== null && now - s.lastRequestAt <= CACHE_TTL_MS) {
          s.mode = 'watching'; // 出现了新请求，缓存重新变热
          this.changed();
        }
        return;
      case 'watching': {
        const { intervalSec } = this.deps.getSettings();
        if (s.streak >= streakCap(intervalSec)) {
          this.markCapped(s);
          return;
        }
        if (s.lastRequestAt === null) return;
        if (!isIdle(entry)) {
          // 忙碌时不发送也无法保活，但缓存快失效时要让用户知道
          if (!s.stallWarned && now - s.lastRequestAt >= STALL_WARN_MS) this.warnStall(s, now);
          return;
        }
        s.stallWarned = false;
        const elapsed = now - s.lastRequestAt;
        if (elapsed > CACHE_TTL_MS) {
          s.mode = 'expired';
          this.changed();
        } else if (elapsed >= intervalSec * 1000) {
          await this.beginSend(s, entry);
        }
        return;
      }
      default:
        return; // failed、capped：保持原状，等用户取消再勾选
    }
  }

  /** 处理新增的 user 记录：只有真正的新请求才打断连续次数（最后请求时间由 poll.lastRequestAt 给出） */
  private absorb(s: MonitorState, records: readonly UserRecord[]): void {
    if (records.length === 0) return;
    if (s.mode === 'sending' && !s.pending) {
      const q = this.deferred.get(s) ?? [];
      q.push(...records);
      this.deferred.set(s, q);
      return;
    }
    for (const r of records) {
      if (r.originMsgId !== undefined && this.sentIds.has(r.originMsgId)) {
        if (s.pending?.msgId === r.originMsgId) s.pending.matched = true;
        continue;
      }
      // 工具返回、系统注入的伴随记录（isMeta 且不是 peer 消息）只刷新时间。
      // 实测：其他会话发来的 peer 消息在记录里同样带 isMeta: true，它们是新请求。
      if (r.isToolResult || (r.isMeta && r.originKind !== 'peer')) continue;
      s.streak = 0; // 人工输入或其他会话发来的消息
    }
    this.changed();
  }

  private async beginSend(s: MonitorState, entry: RegistryEntry): Promise<void> {
    const { content } = this.deps.getSettings();
    s.mode = 'sending';
    s.pending = null;
    this.changed();

    let msgId: string;
    try {
      ({ msgId } = await this.deps.sender.send(
        { sessionId: entry.sessionId, pid: entry.pid, socketPath: entry.messagingSocketPath },
        content,
      ));
    } catch (e) {
      if (this.map.get(s.sessionId) === s) {
        this.fail(s, { ok: false, at: this.deps.clock.now(), status: 'error', reason: errMessage(e) });
      }
      return;
    }
    this.sentIds.add(msgId);
    if (this.map.get(s.sessionId) !== s) return;
    s.pending = { msgId, sentAt: this.deps.clock.now(), matched: false };
    const queued = this.deferred.get(s);
    if (queued) {
      this.deferred.delete(s);
      this.absorb(s, queued);
    }
    this.resolvePending(s, this.deps.clock.now());
  }

  /** 成功：回执 delivered，或记录里出现 origin.msg_id 等于本次 msgId；失败：其他回执，或超时 */
  private resolvePending(s: MonitorState, now: number): void {
    const p = s.pending;
    if (!p) return;
    const receipt = this.receipts.get(p.msgId);
    if (p.matched || receipt?.status === 'delivered') {
      this.receipts.delete(p.msgId);
      s.pending = null;
      s.streak += 1;
      s.lastResult = { ok: true, at: now, status: 'delivered' };
      if (s.lastRequestAt === null || p.sentAt > s.lastRequestAt) s.lastRequestAt = p.sentAt;
      s.mode = 'watching';
      this.changed();
      if (s.streak >= streakCap(this.deps.getSettings().intervalSec)) this.markCapped(s);
      return;
    }
    if (receipt) {
      this.receipts.delete(p.msgId);
      const r: SendResult = { ok: false, at: now, status: receipt.status };
      if (receipt.reason !== undefined) r.reason = receipt.reason;
      if (receipt.dropReason !== undefined) r.dropReason = receipt.dropReason;
      this.fail(s, r);
      return;
    }
    if (now - p.sentAt >= SEND_TIMEOUT_MS) {
      this.fail(s, { ok: false, at: now, status: 'timeout' });
    }
  }

  private fail(s: MonitorState, result: SendResult): void {
    s.pending = null;
    s.mode = 'failed';
    s.lastResult = result;
    this.changed();
    const { title, detail } = describeFailure(result);
    this.deps.notify({
      kind: 'failed',
      sessionId: s.sessionId,
      title: '缓存保活：发送失败',
      body: `「${s.name}」${title}${detail ? `：${detail}` : ''}`,
    });
  }

  private warnStall(s: MonitorState, now: number): void {
    s.stallWarned = true;
    const secs = Math.floor((now - (s.lastRequestAt ?? now)) / 1000);
    this.deps.notify({
      kind: 'stalled',
      sessionId: s.sessionId,
      title: '缓存保活：缓存即将失效',
      body: `「${s.name}」仍在执行任务，距上次请求已 ${Math.floor(secs / 60)} 分 ${secs % 60} 秒，忙碌中无法保活。如果是卡住的工具，可以手动中断。`,
    });
    this.changed();
  }

  private markCapped(s: MonitorState): void {
    s.mode = 'capped';
    this.changed();
    this.deps.notify({
      kind: 'capped',
      sessionId: s.sessionId,
      title: '缓存保活：已达连续上限',
      body: `「${s.name}」已连续发送 ${s.streak} 次，已停止保活。`,
    });
  }

  private markGone(s: MonitorState): void {
    this.deps.transcripts.forget(s.sessionId);
    s.mode = 'gone';
    s.pending = null;
    s.streak = 0;
    s.note = '会话已退出，勾选已自动取消';
    this.changed();
  }

  private changed(): void {
    this.deps.onChange?.();
  }
}

/** 绕开 await 之后 TS 对 mode 的过窄推断 */
function modeOf(s: MonitorState): Mode {
  return s.mode;
}

/** status 缺失按空闲处理；busy、waiting、shell 都不是空闲 */
function isIdle(e: RegistryEntry): boolean {
  return e.status === undefined || e.status === 'idle';
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 距下次发送的毫秒数；非监控态返回 null。已到点（含等待空闲）返回 0 */
export function countdownMs(s: MonitorState, intervalSec: number, now: number): number | null {
  if (s.mode !== 'watching' || s.lastRequestAt === null) return null;
  return Math.max(0, s.lastRequestAt + intervalSec * 1000 - now);
}
