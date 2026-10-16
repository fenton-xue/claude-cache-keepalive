import { compareVersions, describeUpdateError, parseRelease, parseSha256, pickAssets, type ReleaseAsset } from '../core/update';
import type { UpdateAction, UpdateState } from '../shared/ipc';

/** 联网、下载、安装都在这个接口后面，状态机本身不碰网络和文件系统 */
export interface UpdateIo {
  /** GET releases/latest 的 JSON；非 2xx 抛 UpdateHttpError */
  fetchLatest(signal: AbortSignal): Promise<unknown>;
  fetchText(url: string, signal: AbortSignal): Promise<string>;
  /** 下载并边下边算 SHA-256 */
  download(
    asset: ReleaseAsset,
    signal: AbortSignal,
    onProgress: (received: number, total: number | undefined) => void,
  ): Promise<{ path: string; sha256: string }>;
  /** 删除已下载的安装包和临时文件 */
  discard(): void;
  /** 安装：返回 restarting 表示后台脚本已就绪、宿主应当退出；manual 表示没有权限，已在 Finder 里打开安装包 */
  install(dmgPath: string, version: string): Promise<'restarting' | 'manual'>;
}

export interface UpdaterDeps {
  io: UpdateIo;
  currentVersion: string;
  arch: string;
  /** 开发模式（electron .）只能检查，不能安装 */
  isPackaged: boolean;
  monitoringCount: () => number;
  push: (s: UpdateState) => void;
  /** 安装脚本就绪后，按正常退出流程退出 */
  quit: () => void;
}

/** 检查更新、下载、安装的状态机（需求第 14 节）。同一时刻只有一个流程。 */
export class Updater {
  private state: UpdateState;
  private abort: AbortController | null = null;
  private pkg: { path: string; version: string } | null = null;
  private retryAction: UpdateAction | null = null;
  private release: ReturnType<typeof parseRelease> = null;

  constructor(private readonly deps: UpdaterDeps) {
    this.state = { step: 'idle', current: deps.currentVersion };
  }

  getState(): UpdateState {
    return this.state;
  }

  /** 菜单“检查更新…”：没有流程在进行就开始检查，否则只是把当前状态再推一次 */
  begin(): void {
    if (this.state.step === 'idle') void this.check();
    else this.deps.push(this.state);
  }

  act(action: UpdateAction): void {
    switch (action) {
      case 'update':
        if (this.state.step === 'available') void this.download();
        break;
      case 'install':
        if (this.state.step === 'ready') void this.install();
        break;
      case 'retry':
        if (this.state.step === 'error' && this.retryAction) {
          const a = this.retryAction;
          if (a === 'update') void this.download();
          else if (a === 'install') void this.install();
          else void this.check();
        }
        break;
      case 'cancel':
      case 'close':
        if (this.state.step !== 'installing') this.reset();
        break;
    }
  }

  // ---------------------------------------------------------------- 步骤

  private async check(): Promise<void> {
    const ac = this.newAbort();
    this.set({ step: 'checking' });
    try {
      const rel = parseRelease(await this.deps.io.fetchLatest(ac.signal));
      if (ac.signal.aborted) return;
      if (!rel) throw new Error('无法识别最新版本的信息');
      if (compareVersions(rel.version, this.deps.currentVersion) <= 0) {
        this.set({ step: 'latest' });
        return;
      }
      this.release = rel;
      this.set({ step: 'available', latest: rel.version });
    } catch (e) {
      this.fail(ac, e, 'retry');
    }
  }

  private async download(): Promise<void> {
    const rel = this.release;
    if (!rel) return;
    if (!this.deps.isPackaged) return this.setError('开发模式不支持安装更新', false);
    const assets = pickAssets(rel, this.deps.arch);
    if (!assets) return this.setError(`该版本没有适用于 ${this.deps.arch} 的安装包`, false);
    const ac = this.newAbort();
    this.set({ step: 'downloading', latest: rel.version, received: 0 });
    try {
      const expected = parseSha256(await this.deps.io.fetchText(assets.sha.url, ac.signal));
      if (!expected) throw new Error('校验文件格式不对');
      const got = await this.deps.io.download(assets.dmg, ac.signal, (received, total) => {
        if (this.state.step === 'downloading' && !ac.signal.aborted) this.set({ step: 'downloading', latest: rel.version, received, ...(total ? { total } : {}) });
      });
      if (ac.signal.aborted) return;
      if (got.sha256 !== expected) {
        this.deps.io.discard();
        return this.setError('安装包校验失败，已删除，请重试', true, 'update');
      }
      this.pkg = { path: got.path, version: rel.version };
      this.set({ step: 'ready', latest: rel.version, monitoring: this.deps.monitoringCount() });
    } catch (e) {
      this.deps.io.discard();
      this.fail(ac, e, 'update');
    }
  }

  private async install(): Promise<void> {
    const pkg = this.pkg;
    if (!pkg) return;
    this.set({ step: 'installing', latest: pkg.version });
    try {
      const r = await this.deps.io.install(pkg.path, pkg.version);
      if (r === 'restarting') {
        this.deps.quit();
        return;
      }
      this.set({
        step: 'manual',
        latest: pkg.version,
        message: '没有权限覆盖当前应用',
        detail: '已在 Finder 中打开安装包，请手动把 Keepwarm 拖进「应用程序」。',
      });
    } catch (e) {
      this.setError(describeUpdateError(e), true, 'install', pkg.version);
    }
  }

  // ---------------------------------------------------------------- 内部

  /** 开始一个可取消的阶段：中止上一个阶段，换上新的 AbortController */
  private newAbort(): AbortController {
    this.abort?.abort();
    this.abort = new AbortController();
    return this.abort;
  }

  private fail(ac: AbortController, e: unknown, retry: UpdateAction): void {
    if (ac.signal.aborted) return; // 用户取消
    this.setError(describeUpdateError(e), true, retry);
  }

  private setError(message: string, retry: boolean, action?: UpdateAction, latest?: string): void {
    this.retryAction = retry ? (action ?? 'retry') : null;
    this.set({ step: 'error', message, retry, ...(latest ? { latest } : this.state.latest ? { latest: this.state.latest } : {}) });
  }

  /** 取消或关闭：中止进行中的阶段，删除已下载的文件，回到空闲 */
  private reset(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.pkg || this.state.step === 'downloading') this.deps.io.discard();
    this.pkg = null;
    this.release = null;
    this.retryAction = null;
    this.set({ step: 'idle' });
  }

  private set(s: Omit<UpdateState, 'current'>): void {
    this.state = { ...s, current: this.deps.currentVersion };
    this.deps.push(this.state);
  }
}
