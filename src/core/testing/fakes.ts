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

/** 假的会话记录：按 sessionId 存 user 记录，poll 的游标语义和真实实现一致 */
export class FakeTranscripts implements TranscriptSource {
  records = new Map<string, UserRecord[]>();
  missing = new Set<string>();
  failing = new Set<string>();
  private cursors = new Map<string, number>();

  addUser(sessionId: string, r: Partial<UserRecord> & { timestamp: number }): UserRecord {
    const rec: UserRecord = { isToolResult: false, isMeta: false, ...r };
    const list = this.records.get(sessionId) ?? [];
    list.push(rec);
    this.records.set(sessionId, list);
    return rec;
  }

  async peekLast(sessionId: string): Promise<UserRecord | null | undefined> {
    if (this.failing.has(sessionId)) throw new Error('read error');
    if (this.missing.has(sessionId)) return undefined;
    const list = this.records.get(sessionId) ?? [];
    return list[list.length - 1] ?? null;
  }

  async poll(sessionId: string): Promise<TranscriptPoll | undefined> {
    if (this.failing.has(sessionId)) throw new Error('read error');
    if (this.missing.has(sessionId)) return undefined;
    const list = this.records.get(sessionId) ?? [];
    const cursor = this.cursors.get(sessionId);
    this.cursors.set(sessionId, list.length);
    return {
      lastUser: list[list.length - 1] ?? null,
      appended: cursor === undefined ? [] : list.slice(cursor),
    };
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
