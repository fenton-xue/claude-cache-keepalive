/** 与 Electron、文件系统无关的核心类型和注入接口。时间一律用毫秒时间戳。 */

export type SessionStatus = 'idle' | 'busy' | 'waiting' | 'shell';

/** ~/.claude/sessions/<pid>.json 中本程序用到的字段 */
export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  entrypoint: string;
  messagingSocketPath: string;
  name?: string;
  status?: SessionStatus;
  statusUpdatedAt?: number;
  updatedAt?: number;
}

/** 会话记录里的一条 user 记录（含工具返回） */
export interface UserRecord {
  /** 毫秒时间戳 */
  timestamp: number;
  /** message.content 里含 tool_result */
  isToolResult: boolean;
  /** isMeta：系统注入的伴随记录（如技能内容），不算用户发起的新请求 */
  isMeta: boolean;
  originKind?: string;
  originMsgId?: string;
}

export interface Clock {
  now(): number;
}

/** 读取注册目录。无法解析的文件由实现跳过。 */
export interface SessionRegistry {
  list(): Promise<RegistryEntry[]>;
}

export interface SystemProbe {
  isPidAlive(pid: number): boolean;
  socketExists(path: string): boolean;
}

export interface TranscriptPoll {
  /** 目前已知的最后一条 user 记录；记录里还没有 user 记录时为 null */
  lastUser: UserRecord | null;
  /** 自上一次 poll 以来新增的 user 记录；第一次 poll 恒为空 */
  appended: UserRecord[];
}

export interface TranscriptSource {
  /** 无状态地取最后一条 user 记录。记录文件找不到返回 undefined，没有 user 记录返回 null。 */
  peekLast(sessionId: string): Promise<UserRecord | null | undefined>;
  /** 有状态地跟读：第一次建立基线，之后只返回新增。记录文件找不到返回 undefined。 */
  poll(sessionId: string): Promise<TranscriptPoll | undefined>;
  /** 丢弃该会话的跟读游标 */
  forget(sessionId: string): void;
}

export interface SendTarget {
  sessionId: string;
  pid: number;
  /** 发送前刚从注册文件读到的当前套接字 */
  socketPath: string;
}

/** 发送能力集中在这个接口后面，cc-peer 只是其中一种实现 */
export interface Sender {
  send(target: SendTarget, body: string): Promise<{ msgId: string }>;
}

export type ReceiptStatus = 'held' | 'delivered' | 'denied' | 'expired' | 'dropped';

export interface SendReceipt {
  /** 对应本程序发送时返回的 msgId */
  origMsgId: string;
  status: ReceiptStatus;
  reason?: string;
  dropReason?: string;
}

export interface Notice {
  kind: 'failed' | 'capped' | 'stalled';
  sessionId: string;
  title: string;
  body: string;
}
