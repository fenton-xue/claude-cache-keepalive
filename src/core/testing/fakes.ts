import type {
  Clock,
  RegistryEntry,
  SendTarget,
  Sender,
  SessionRegistry,
  SystemProbe,
  TranscriptPoll,
  TranscriptSource,
  UserRecord,
} from '../types';
import { RequestTracker, type TxRecord } from '../transcript';

export const T0 = Date.parse('2026-10-15T08:00:00.000Z');

export class FakeClock implements Clock {
  constructor(public t = T0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** 假的注册目录：测试直接改 entries */
export class FakeRegistry implements SessionRegistry, SystemProbe {
  entries: RegistryEntry[] = [];
  deadPids = new Set<number>();
  missingSockets = new Set<string>();
  listError: Error | null = null;

  async list(): Promise<RegistryEntry[]> {
    if (this.listError) throw this.listError;
    return this.entries.map((e) => ({ ...e }));
  }
  isPidAlive(pid: number): boolean {
    return !this.deadPids.has(pid);
  }
  socketExists(path: string): boolean {
    return !this.missingSockets.has(path);
  }

  add(e: Partial<RegistryEntry> & { sessionId: string; pid: number }): RegistryEntry {
    const entry: RegistryEntry = {
      cwd: '/work/proj',
      entrypoint: 'claude-desktop-3p',
      messagingSocketPath: `/tmp/cc-socks/${e.pid}.sock`,
      status: 'idle',
      name: e.sessionId,
      ...e,
    };
    this.entries.push(entry);
    return entry;
  }
  get(sessionId: string): RegistryEntry {
    const e = this.entries.find((x) => x.sessionId === sessionId);
    if (!e) throw new Error(`no entry ${sessionId}`);
    return e;
  }
  remove(sessionId: string): void {
    this.entries = this.entries.filter((x) => x.sessionId !== sessionId);
  }
}

/** 假的会话记录：按 sessionId 存 user / assistant 记录，poll 的游标语义和真实实现一致 */
export class FakeTranscripts implements TranscriptSource {
  records = new Map<string, TxRecord[]>();
  missing = new Set<string>();
  failing = new Set<string>();
  private cursors = new Map<string, number>();

  private push(sessionId: string, rec: TxRecord): void {
    const list = this.records.get(sessionId) ?? [];
    list.push(rec);
    this.records.set(sessionId, list);
  }

  addUser(sessionId: string, r: Partial<UserRecord> & { timestamp: number }): UserRecord {
    const rec = { kind: 'user' as const, isToolResult: false, isMeta: false, ...r };
    this.push(sessionId, rec);
    return rec;
  }

  addAssistant(sessionId: string, timestamp: number): void {
    this.push(sessionId, { kind: 'assistant', timestamp });
  }

  /** 工具返回；answered 为 true 时紧跟一条 assistant 回复（表示下一次请求已发出并得到响应） */
  addToolResult(sessionId: string, timestamp: number, answered = true): UserRecord {
    const rec = this.addUser(sessionId, { timestamp, isToolResult: true });
    if (answered) this.addAssistant(sessionId, timestamp + 1);
    return rec;
  }

  private requestTime(sessionId: string): number | null {
    const t = new RequestTracker();
    for (const r of this.records.get(sessionId) ?? []) t.feed(r);
    return t.get();
  }

  async peekLastRequest(sessionId: string): Promise<number | null | undefined> {
    if (this.failing.has(sessionId)) throw new Error('read error');
    if (this.missing.has(sessionId)) return undefined;
    return this.requestTime(sessionId);
  }

  async poll(sessionId: string): Promise<TranscriptPoll | undefined> {
    if (this.failing.has(sessionId)) throw new Error('read error');
    if (this.missing.has(sessionId)) return undefined;
    const list = this.records.get(sessionId) ?? [];
    const cursor = this.cursors.get(sessionId);
    this.cursors.set(sessionId, list.length);
    const appended = (cursor === undefined ? [] : list.slice(cursor)).filter((r): r is Extract<TxRecord, { kind: 'user' }> => r.kind === 'user');
    return { lastRequestAt: this.requestTime(sessionId), appended };
  }

  forget(sessionId: string): void {
    this.cursors.delete(sessionId);
  }
}

export type DeliverMode = 'transcript' | 'none' | 'throw';

/** 假的发送器：记录每次发送，并按 mode 模拟目标会话的反应 */
export class FakeSender implements Sender {
  sent: { target: SendTarget; body: string; msgId: string }[] = [];
  mode: DeliverMode = 'transcript';
  /** send() 返回前执行，用来模拟“回执先于返回到达” */
  beforeReturn: ((msgId: string) => void) | null = null;
  private seq = 0;

  constructor(
    private readonly clock: FakeClock,
    private readonly transcripts: FakeTranscripts,
  ) {}

  async send(target: SendTarget, body: string): Promise<{ msgId: string }> {
    if (this.mode === 'throw') throw new Error('socket closed');
    const msgId = `msg-${++this.seq}`;
    this.sent.push({ target, body, msgId });
    if (this.mode === 'transcript') {
      this.transcripts.addUser(target.sessionId, {
        timestamp: this.clock.now() + 500,
        originKind: 'peer',
        originMsgId: msgId,
      });
    }
    this.beforeReturn?.(msgId);
    return { msgId };
  }
}
