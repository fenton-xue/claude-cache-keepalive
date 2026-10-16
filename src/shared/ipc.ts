import type { CandidateList, GroupView } from '../core/catalog';

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

/** 检查更新流程的当前步骤（需求第 14 节）；界面按它渲染通用的步骤弹层 */
export type UpdateStep =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'manual'
  | 'error';

export interface UpdateState {
  step: UpdateStep;
  /** 当前运行的版本 */
  current: string;
  /** 发现的新版本 */
  latest?: string;
  received?: number;
  total?: number;
  /** error、manual 时的说明；manual 的第二行放 detail */
  message?: string;
  detail?: string;
  /** error 时是否提供“重试” */
  retry?: boolean;
  /** ready 时正在监控的会话数 */
  monitoring?: number;
}

export type UpdateAction = 'update' | 'install' | 'cancel' | 'retry' | 'close';

export interface KeepaliveApi {
  getState(): Promise<UiState>;
  onState(cb: (s: UiState) => void): () => void;
  addDir(): Promise<void>;
  removeDir(path: string): Promise<void>;
  moveDir(path: string, delta: -1 | 1): Promise<void>;
  setCollapsed(path: string, collapsed: boolean): Promise<void>;
  setContent(text: string): Promise<Validation>;
  setInterval(text: string): Promise<Validation>;
  /** id 均为桌面版会话 id */
  setChecked(id: string, on: boolean): Promise<void>;
  confirm(id: string): Promise<void>;
  refresh(): Promise<void>;
  listCandidates(dirPath: string): Promise<CandidateList>;
  addSessions(dirPath: string, ids: string[]): Promise<void>;
  removeSession(dirPath: string, id: string): Promise<void>;
  getUpdateState(): Promise<UpdateState>;
  onUpdate(cb: (s: UpdateState) => void): () => void;
  updateAction(action: UpdateAction): Promise<void>;
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
  listCandidates: 'keepalive:listCandidates',
  addSessions: 'keepalive:addSessions',
  removeSession: 'keepalive:removeSession',
  getUpdateState: 'keepalive:getUpdateState',
  update: 'keepalive:update',
  updateAction: 'keepalive:updateAction',
} as const;
