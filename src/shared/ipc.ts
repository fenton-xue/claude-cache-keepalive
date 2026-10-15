import type { GroupView } from '../core/catalog';

/** 主进程推给界面的完整状态 */
export interface UiState {
  /** 主进程时钟，毫秒 */
  now: number;
  content: string;
  intervalSec: number;
  groups: GroupView[];
  /** 发送通道（cc-peer）启动失败时的说明；正常为 null */
  peerError: string | null;
}

/** 校验失败返回错误文案，成功返回 null */
export type Validation = string | null;

export interface KeepaliveApi {
  getState(): Promise<UiState>;
  onState(cb: (s: UiState) => void): () => void;
  addDir(): Promise<void>;
  removeDir(path: string): Promise<void>;
  moveDir(path: string, delta: -1 | 1): Promise<void>;
  setCollapsed(path: string, collapsed: boolean): Promise<void>;
  setContent(text: string): Promise<Validation>;
  setInterval(text: string): Promise<Validation>;
  setChecked(sessionId: string, on: boolean): Promise<void>;
  confirm(sessionId: string): Promise<void>;
  refresh(): Promise<void>;
}

export const IPC = {
  state: 'keepalive:state',
  getState: 'keepalive:getState',
  addDir: 'keepalive:addDir',
  removeDir: 'keepalive:removeDir',
  moveDir: 'keepalive:moveDir',
  setCollapsed: 'keepalive:setCollapsed',
  setContent: 'keepalive:setContent',
  setInterval: 'keepalive:setInterval',
  setChecked: 'keepalive:setChecked',
  confirm: 'keepalive:confirm',
  refresh: 'keepalive:refresh',
} as const;
