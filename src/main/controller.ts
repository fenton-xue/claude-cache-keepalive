import { Catalog } from '../core/catalog';
import { normalizePath } from '../core/directories';
import { Monitor } from '../core/monitor';
import {
  parseInterval,
  validateContent,
  validateInterval,
  type Settings,
} from '../core/settings';
import type {
  Clock,
  Notice,
  SendReceipt,
  Sender,
  SessionRegistry,
  SystemProbe,
  TranscriptSource,
} from '../core/types';
import type { UiState, Validation } from '../shared/ipc';

export interface ControllerDeps {
  clock: Clock;
  registry: SessionRegistry;
  probe: SystemProbe;
  transcripts: TranscriptSource;
  sender: Sender;
  loadSettings: () => Settings;
  saveSettings: (s: Settings) => void;
  notify: (n: Notice) => void;
  /** 弹出系统选择文件夹对话框；取消返回 null */
  pickDirectory: () => Promise<string | null>;
  push: (s: UiState) => void;
  getPeerError: () => string | null;
  log?: (msg: string, err?: unknown) => void;
}

const TICK_MS = 1000;
/** 未勾选会话的最后请求时间多久重新读取一次 */
const RELOAD_MS = 60 * 60 * 1000;

/** 把核心模块、设置和界面串起来。不依赖 Electron，便于测试。 */
export class Controller {
  readonly monitor: Monitor;
  private readonly catalog: Catalog;
  private settings: Settings;
  private timer: NodeJS.Timeout | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private pushQueued = false;

  constructor(private readonly deps: ControllerDeps) {
    this.settings = deps.loadSettings();
    this.catalog = new Catalog({
      registry: deps.registry,
      probe: deps.probe,
      transcripts: deps.transcripts,
      clock: deps.clock,
    });
    this.monitor = new Monitor({
      clock: deps.clock,
      registry: deps.registry,
      probe: deps.probe,
      transcripts: deps.transcripts,
      sender: deps.sender,
      getSettings: () => ({ content: this.settings.content, intervalSec: this.settings.intervalSec }),
      notify: deps.notify,
      onChange: () => this.schedulePush(),
    });
  }

  async start(): Promise<void> {
    await this.catalog.refresh();
    this.push();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.reloadTimer = setInterval(() => {
      void this.catalog
        .reloadLastRequests(this.settings.dirs.map((d) => d.path))
        .catch((e) => this.deps.log?.('reload last requests failed', e));
    }, RELOAD_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    this.timer = null;
    this.reloadTimer = null;
    this.monitor.stopAll();
  }

  /** 收到 cc-peer 回执时由宿主调用 */
  onReceipt(r: SendReceipt): void {
    this.monitor.onReceipt(r);
  }

  getState(): UiState {
    return {
      now: this.deps.clock.now(),
      content: this.settings.content,
      intervalSec: this.settings.intervalSec,
      groups: this.catalog.view(this.settings.dirs, new Map(this.monitor.states().map((s) => [s.sessionId, s])), this.settings.intervalSec),
      peerError: this.deps.getPeerError(),
    };
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await Promise.all([
        this.catalog.tick().catch((e) => this.deps.log?.('catalog tick failed', e)),
        this.monitor.tick(),
      ]);
      this.push();
    } finally {
      this.ticking = false;
    }
  }

  async addDir(): Promise<void> {
    const picked = await this.deps.pickDirectory();
    if (!picked) return;
    const path = normalizePath(picked);
    if (this.settings.dirs.some((d) => normalizePath(d.path) === path)) return;
    this.settings.dirs.push({ path, collapsed: false });
    this.persist();
    await this.catalog.refresh(); // 添加目录时重排
    this.push();
  }

  removeDir(path: string): void {
    const paths = this.settings.dirs.map((d) => d.path);
    for (const id of this.catalog.sessionIdsIn(paths, path)) this.monitor.uncheck(id);
    this.settings.dirs = this.settings.dirs.filter((d) => d.path !== path);
    this.persist();
    this.push();
  }

  moveDir(path: string, delta: -1 | 1): void {
    const dirs = this.settings.dirs;
    const i = dirs.findIndex((d) => d.path === path);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= dirs.length) return;
    [dirs[i], dirs[j]] = [dirs[j] as (typeof dirs)[number], dirs[i] as (typeof dirs)[number]];
    this.persist();
    this.push();
  }

  setCollapsed(path: string, collapsed: boolean): void {
    const d = this.settings.dirs.find((x) => x.path === path);
    if (!d || d.collapsed === collapsed) return;
    d.collapsed = collapsed;
    this.persist();
    this.push();
  }

  setContent(text: string): Validation {
    const err = validateContent(text);
    if (err) return err;
    this.settings.content = text.trim();
    this.persist();
    this.push();
    return null;
  }

  setIntervalText(text: string): Validation {
    const sec = parseInterval(text);
    const err = validateInterval(sec);
    if (err || sec === null) return err;
    this.settings.intervalSec = sec;
    this.persist();
    this.push();
    return null;
  }

  async setChecked(sessionId: string, on: boolean): Promise<void> {
    if (on) {
      await this.monitor.check(sessionId);
    } else {
      this.monitor.uncheck(sessionId);
      await this.catalog.reloadLastRequest(sessionId).catch(() => undefined);
    }
    this.push();
  }

  async confirm(sessionId: string): Promise<void> {
    await this.monitor.confirm(sessionId);
    this.push();
  }

  /** 手动刷新：重新读取会话并按目录归组，清掉“会话已退出”提示 */
  async refresh(): Promise<void> {
    this.monitor.clearGone();
    await this.catalog.refresh();
    this.push();
  }

  private persist(): void {
    try {
      this.deps.saveSettings(this.settings);
    } catch (e) {
      this.deps.log?.('save settings failed', e);
    }
  }

  private schedulePush(): void {
    if (this.pushQueued) return;
    this.pushQueued = true;
    queueMicrotask(() => {
      this.pushQueued = false;
      this.push();
    });
  }

  private push(): void {
    this.deps.push(this.getState());
  }
}
