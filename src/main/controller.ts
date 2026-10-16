import { Catalog, type CandidateList } from '../core/catalog';
import { normalizePath, ownerOf } from '../core/directories';
import { Monitor, type Mode } from '../core/monitor';
import {
  SETTINGS_SCHEMA,
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
  SessionStore,
  SystemProbe,
  TranscriptSource,
} from '../core/types';
import type { UiState, Validation } from '../shared/ipc';

export interface ControllerDeps {
  clock: Clock;
  registry: SessionRegistry;
  /** 桌面版会话存储（只读），用来列出未运行的会话 */
  store: SessionStore;
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
/** 记住勾选的状态：监控中、发送中、已过期（已失败、已达上限的已经停止，不记） */
const REMEMBER_MODES: readonly Mode[] = ['watching', 'sending', 'expired'];

/** 把核心模块、设置和界面串起来。不依赖 Electron，便于测试。 */
export class Controller {
  readonly monitor: Monitor;
  private readonly catalog: Catalog;
  private settings: Settings;
  private timer: NodeJS.Timeout | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private pushQueued = false;
  /** 启动时还没运行的已勾选会话（桌面版会话 id），等它第一次可用时自动恢复勾选 */
  private readonly pending = new Set<string>();
  /** 启动恢复完成之前、退出过程中都不能改写记住的勾选集合 */
  private restored = false;
  private stopped = false;

  constructor(private readonly deps: ControllerDeps) {
    this.settings = deps.loadSettings();
    this.catalog = new Catalog({
      registry: deps.registry,
      store: deps.store,
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
    await this.migrate();
    const { gone } = await this.catalog.refresh(this.allMembers());
    this.dropMembers(gone);
    await this.restore();
    this.restored = true;
    this.push();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.reloadTimer = setInterval(() => {
      void this.catalog
        .reloadLastRequests(this.allMembers())
        .catch((e) => this.deps.log?.('reload last requests failed', e));
    }, RELOAD_MS);
  }

  stop(): void {
    this.stopped = true; // monitor.stopAll 会触发推送，不能让它把记住的勾选集合清空
    if (this.timer) clearInterval(this.timer);
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    this.timer = null;
    this.reloadTimer = null;
    this.monitor.stopAll();
  }

  /** 正在监控的会话数（更新确认框用） */
  monitoringCount(): number {
    return this.monitor.states().filter((s) => REMEMBER_MODES.includes(s.mode)).length;
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
      groups: this.catalog.view(
        this.settings.dirs,
        new Map(this.monitor.states().map((s) => [s.sessionId, s])),
        this.settings.intervalSec,
        this.pending,
      ),
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
      await this.restorePending();
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
    this.settings.dirs.push({ path, collapsed: false, members: [] }); // 新工作区默认是空的
    this.persist();
    this.catalog.requestResort();
    this.push();
  }

  removeDir(path: string): void {
    const dir = this.settings.dirs.find((d) => d.path === path);
    if (!dir) return;
    this.dropMembers(dir.members);
    this.settings.dirs = this.settings.dirs.filter((d) => d.path !== path);
    this.persist();
    this.push();
  }

  /** 添加会话弹窗的候选列表 */
  listCandidates(dirPath: string): Promise<CandidateList> {
    return this.catalog.candidates(dirPath, this.settings.dirs);
  }

  /** 把会话添加到工作区。只接受当前候选里的会话，只改设置，不碰桌面版 */
  async addSessions(dirPath: string, ids: readonly string[]): Promise<void> {
    const dir = this.settings.dirs.find((d) => d.path === dirPath);
    if (!dir) return;
    const allowed = new Set((await this.listCandidates(dirPath)).items.map((c) => c.id));
    const accepted = [...new Set(ids)].filter((id) => allowed.has(id));
    if (accepted.length === 0) return;
    dir.members.push(...accepted);
    this.persist();
    await this.catalog.onMembersAdded(dirPath, accepted);
    this.push();
  }

  /** 把会话移出工作区：停止监控并从成员里删除，桌面版里的会话不受影响 */
  removeSession(dirPath: string, id: string): void {
    const dir = this.settings.dirs.find((d) => d.path === dirPath);
    if (!dir || !dir.members.includes(id)) return;
    this.dropMembers([id]);
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

  async setChecked(id: string, on: boolean): Promise<void> {
    const cli = this.catalog.cliIdOf(id);
    this.pending.delete(id);
    if (on) {
      if (cli !== undefined) await this.monitor.check(cli);
    } else if (cli !== undefined) {
      this.monitor.uncheck(cli);
      await this.catalog.reloadLastRequest(id).catch(() => undefined);
    }
    this.push();
  }

  async confirm(id: string): Promise<void> {
    const cli = this.catalog.cliIdOf(id);
    if (cli !== undefined) await this.monitor.confirm(cli);
    this.push();
  }

  /** 手动刷新：重新读取会话，移出已归档、已删除的成员，清掉“会话已退出”提示，并重排 */
  async refresh(): Promise<void> {
    this.monitor.clearGone();
    const { gone } = await this.catalog.refresh(this.allMembers());
    if (gone.length > 0) {
      this.dropMembers(gone);
      this.persist();
    }
    this.push();
  }

  // ---------------------------------------------------------------- 成员、迁移、恢复

  private allMembers(): string[] {
    return this.settings.dirs.flatMap((d) => d.members);
  }

  /** 从所有工作区的成员里去掉这些会话，并停止它们的监控（不保存、不推送，由调用方负责） */
  private dropMembers(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    for (const id of drop) {
      const cli = this.catalog.cliIdOf(id);
      if (cli !== undefined) this.monitor.uncheck(cli);
      this.pending.delete(id);
    }
    for (const d of this.settings.dirs) d.members = d.members.filter((id) => !drop.has(id));
  }

  /** 需求 5.7：从 v1.3 升级后首次启动，把旧目录当时匹配到的运行中会话一次性变成成员 */
  private async migrate(): Promise<void> {
    if (this.settings.schemaVersion >= SETTINGS_SCHEMA) return;
    try {
      await this.catalog.tick();
      const paths = this.settings.dirs.map((d) => d.path);
      for (const s of this.catalog.runningSessions()) {
        const owner = ownerOf(s.cwd, paths);
        const dir = this.settings.dirs.find((d) => d.path === owner);
        if (dir && !this.allMembers().includes(s.id)) dir.members.push(s.id);
      }
    } catch (e) {
      this.deps.log?.('migrate failed', e);
    }
    this.settings.schemaVersion = SETTINGS_SCHEMA;
    this.persist();
  }

  /** 需求 6.4：启动后恢复上次的勾选；还没运行的留作待恢复 */
  private async restore(): Promise<void> {
    const members = new Set(this.allMembers());
    for (const id of this.settings.checked) {
      if (!members.has(id)) continue;
      const cli = this.catalog.cliIdOf(id);
      if (this.catalog.isAvailable(id) && cli !== undefined) await this.monitor.check(cli);
      else this.pending.add(id);
    }
  }

  private async restorePending(): Promise<void> {
    for (const id of [...this.pending]) {
      const cli = this.catalog.cliIdOf(id);
      if (!this.catalog.isAvailable(id) || cli === undefined) continue;
      this.pending.delete(id);
      await this.monitor.check(cli);
    }
  }

  /** 当前应记住的勾选集合：待恢复的 + 处于监控中、发送中、已过期的 */
  private currentChecked(): string[] {
    const out = new Set(this.pending);
    for (const id of this.allMembers()) {
      const cli = this.catalog.cliIdOf(id);
      const s = cli === undefined ? undefined : this.monitor.get(cli);
      if (s && REMEMBER_MODES.includes(s.mode)) out.add(id);
    }
    return [...out].sort();
  }

  private persistChecked(): void {
    if (!this.restored || this.stopped) return;
    const next = this.currentChecked();
    if (next.join('\n') === [...this.settings.checked].sort().join('\n')) return;
    this.settings.checked = next;
    this.persist();
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
    this.persistChecked();
    this.deps.push(this.getState());
  }
}
