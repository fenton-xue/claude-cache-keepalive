import { dirLabels, ownerOf, stableOrder, subPath } from './directories';
import type { SendResult } from './format';
import { countdownMs, type Mode, type MonitorState } from './monitor';
import { bestByHost, displayName, isAvailable, isDesktopSession, shortHostId } from './sessions';
import { CACHE_TTL_MS, STALL_WARN_MS, streakCap, type DirSetting } from './settings';
import type {
  Clock,
  DesktopSession,
  RegistryEntry,
  SessionRegistry,
  SessionStatus,
  SessionStore,
  SystemProbe,
  TranscriptSource,
} from './types';

export type RowMode = 'off' | 'unavailable' | Mode;

export interface SessionRowView {
  /** 桌面版会话 id（hostSessionId）；界面和 IPC 都用它标识会话 */
  id: string;
  name: string;
  shortId: string;
  /** cwd 与所属工作区不同（如 worktree）时的相对路径，否则空串 */
  subPath: string;
  cwd: string;
  status: SessionStatus | undefined;
  available: boolean;
  checked: boolean;
  /** 启动时尚未运行、等它第一次可用时自动恢复勾选（需求 6.4 第 4 条） */
  pendingRestore: boolean;
  mode: RowMode;
  /** 监控中且会话非空闲：到点也不发送，等变为空闲 */
  waitingIdle: boolean;
  /** 忙碌中且缓存快失效 / 已失效：无法保活，提醒用户 */
  stall: 'none' | 'soon' | 'expired';
  lastRequestAt: number | null;
  /** 距最后一次请求的毫秒数 */
  ageMs: number | null;
  /** 缓存已失效多久（超过 5 分钟的部分）；未失效为 0 */
  coldMs: number;
  countdownMs: number | null;
  streak: number;
  cap: number;
  result: SendResult | null;
  note: string | null;
}

export interface GroupView {
  path: string;
  label: string;
  collapsed: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  rows: SessionRowView[];
  summary: { sessions: number; monitoring: number; expired: number; failed: number };
}

/** 添加会话弹窗里的一项 */
export interface Candidate {
  id: string;
  title: string;
  shortId: string;
}

export interface CandidateList {
  items: Candidate[];
  /** 桌面版会话存储读不到，只列出了正在运行的会话 */
  degraded: boolean;
}

export interface CatalogDeps {
  registry: SessionRegistry;
  store: SessionStore;
  probe: SystemProbe;
  transcripts: TranscriptSource;
  clock: Clock;
}

/**
 * 会话列表的内存模型。成员（哪些会话出现在哪个工作区）由设置决定，这里只负责把成员解析成行：
 * - 运行中的会话信息来自注册文件，未运行的来自桌面版会话存储；
 * - refresh（启动、手动刷新）重新读取两处，并找出该移出的成员（已归档、已删除）；
 * - tick 只更新注册文件里的状态和可用性，不改变成员和顺序；
 * - 排序只在 refresh、向工作区添加会话时重新计算。
 */
export class Catalog {
  private running = new Map<string, RegistryEntry>();
  private available = new Map<string, boolean>();
  private stored = new Map<string, DesktopSession>();
  private storeOk = false;
  /** 运行过的会话最后一次见到的名称、cwd、CLI 会话号：会话退出、存储又读不到时仍能显示 */
  private readonly lastSeen = new Map<string, { name: string; cwd: string; cli: string }>();
  private readonly lastReq = new Map<string, number | null>();
  private readonly orders = new Map<string, string[]>();
  private resortAll = true;
  private readonly resortDirs = new Set<string>();

  constructor(private readonly deps: CatalogDeps) {}

  /**
   * 重新读取注册文件和会话存储，返回应从工作区移出的成员：
   * 会话存储读取正常时，已归档的、既不在存储里也没在运行的；存储读不到时不移出任何成员。
   */
  async refresh(memberIds: readonly string[]): Promise<{ gone: string[] }> {
    await this.readRegistry();
    await this.readStore();
    const gone = this.storeOk
      ? memberIds.filter((id) => {
          const st = this.stored.get(id);
          return st ? st.archived : !this.running.has(id);
        })
      : [];
    const goneSet = new Set(gone);
    const keep = memberIds.filter((id) => !goneSet.has(id));
    for (const id of [...this.lastReq.keys()]) if (!keep.includes(id)) this.lastReq.delete(id);
    await this.loadLastRequests(keep);
    this.resortAll = true;
    return { gone };
  }

  /**
   * 更新注册文件里的状态和可用性。
   * 不读取记录文件：未勾选的会话只在刷新、取消勾选和每小时一次的 reloadLastRequests 里更新最后请求时间，
   * 勾选的会话由 Monitor 实时跟踪。
   */
  async tick(): Promise<void> {
    await this.readRegistry();
  }

  /** 重新读取成员的最后请求时间（每小时一次） */
  async reloadLastRequests(memberIds: readonly string[]): Promise<void> {
    await this.loadLastRequests(memberIds);
  }

  /** 取消勾选后，把该会话的最后请求时间更新一次，之后不再自动变化 */
  async reloadLastRequest(id: string): Promise<void> {
    await this.loadLastRequests([id]);
  }

  /** 新加入工作区的成员：读取最后请求时间，并让该工作区下一次 view 重排 */
  async onMembersAdded(dirPath: string, ids: readonly string[]): Promise<void> {
    await this.readRegistry();
    await this.loadLastRequests(ids);
    this.resortDirs.add(dirPath);
  }

  /** 添加工作区时调用：整体重排 */
  requestResort(): void {
    this.resortAll = true;
  }

  /** 当前的 CLI 会话号（运行中取注册文件，未运行取会话存储），用于发送和读取记录 */
  cliIdOf(id: string): string | undefined {
    return this.running.get(id)?.sessionId ?? this.stored.get(id)?.cliSessionId ?? this.lastSeen.get(id)?.cli;
  }

  isAvailable(id: string): boolean {
    return this.available.get(id) === true;
  }

  /** 正在运行的桌面版会话（升级迁移用） */
  runningSessions(): { id: string; cwd: string }[] {
    return [...this.running].map(([id, e]) => ({ id, cwd: e.cwd }));
  }

  /**
   * 添加会话弹窗的候选：归属该工作区（需求 5.2 第 4 条）、未归档、尚未被添加到任何工作区，
   * 按更新时间从新到旧。会话存储读不到时降级为只列运行中的会话。
   */
  async candidates(dirPath: string, dirs: readonly DirSetting[]): Promise<CandidateList> {
    await this.readRegistry();
    await this.readStore();
    const paths = dirs.map((d) => d.path);
    const taken = new Set(dirs.flatMap((d) => d.members));
    const all = new Map<string, { title: string; cwd: string; at: number }>();
    for (const st of this.stored.values()) {
      if (!st.archived) all.set(st.hostSessionId, { title: st.title, cwd: st.cwd, at: st.lastActivityAt });
    }
    for (const [id, e] of this.running) {
      const st = this.stored.get(id);
      if (st?.archived) continue;
      if (!all.has(id)) all.set(id, { title: displayName(e), cwd: e.cwd, at: e.updatedAt ?? e.statusUpdatedAt ?? 0 });
    }
    const items = [...all]
      .filter(([id, v]) => !taken.has(id) && ownerOf(v.cwd, paths) === dirPath)
      .sort((a, b) => b[1].at - a[1].at)
      .map(([id, v]): Candidate => ({ id, title: v.title.trim() !== '' ? v.title : shortHostId(id), shortId: shortHostId(id) }));
    return { items, degraded: !this.storeOk };
  }

  view(dirs: readonly DirSetting[], states: ReadonlyMap<string, MonitorState>, intervalSec: number, pending: ReadonlySet<string>): GroupView[] {
    const now = this.deps.clock.now();
    const labels = dirLabels(dirs.map((d) => d.path));
    const cap = streakCap(intervalSec);
    const resortAll = this.resortAll;
    this.resortAll = false;

    return dirs.map((d, i): GroupView => {
      const stateOf = (id: string) => {
        const cli = this.cliIdOf(id);
        return cli === undefined ? undefined : states.get(cli);
      };
      const members = d.members.map((id) => ({ id, lastRequestAt: stateOf(id)?.lastRequestAt ?? this.lastReq.get(id) ?? null }));
      const resort = resortAll || this.resortDirs.delete(d.path);
      const order = stableOrder(this.orders.get(d.path), members, resort);
      this.orders.set(d.path, order);
      const rows = order.map((id) => this.row(id, d.path, stateOf(id), now, intervalSec, cap, pending.has(id)));
      return {
        path: d.path,
        label: labels.get(d.path) ?? d.path,
        collapsed: d.collapsed,
        canMoveUp: i > 0,
        canMoveDown: i < dirs.length - 1,
        rows,
        summary: {
          sessions: rows.length,
          monitoring: rows.filter((r) => r.mode === 'watching' || r.mode === 'sending').length,
          expired: rows.filter((r) => r.mode === 'expired').length,
          failed: rows.filter((r) => r.mode === 'failed').length,
        },
      };
    });
  }

  private row(id: string, dir: string, s: MonitorState | undefined, now: number, intervalSec: number, cap: number, pendingRestore: boolean): SessionRowView {
    const e = this.running.get(id);
    const st = this.stored.get(id);
    const available = this.available.get(id) === true;
    const checked = s !== undefined && s.mode !== 'gone';
    const lastRequestAt = s?.lastRequestAt ?? this.lastReq.get(id) ?? null;
    const ageMs = lastRequestAt === null ? null : Math.max(0, now - lastRequestAt);
    const mode: RowMode = s ? s.mode : available ? 'off' : 'unavailable';
    const waitingIdle = mode === 'watching' && e?.status !== undefined && e.status !== 'idle';
    const seen = this.lastSeen.get(id);
    const name = e ? displayName({ name: e.name, sessionId: shortHostId(id) }) : st && st.title.trim() !== '' ? st.title : (seen?.name ?? shortHostId(id));
    const cwd = e?.cwd ?? st?.cwd ?? seen?.cwd ?? '';
    return {
      id,
      name,
      shortId: shortHostId(id),
      subPath: cwd === '' ? '' : subPath(cwd, dir),
      cwd,
      status: e?.status,
      available,
      checked,
      pendingRestore,
      mode,
      waitingIdle,
      stall: !waitingIdle || ageMs === null ? 'none' : ageMs >= CACHE_TTL_MS ? 'expired' : ageMs >= STALL_WARN_MS ? 'soon' : 'none',
      lastRequestAt,
      ageMs,
      coldMs: ageMs !== null && ageMs > CACHE_TTL_MS ? ageMs - CACHE_TTL_MS : 0,
      countdownMs: s ? countdownMs(s, intervalSec, now) : null,
      streak: s?.streak ?? 0,
      cap,
      result: s?.lastResult ?? null,
      note: s?.note ?? null,
    };
  }

  private async readRegistry(): Promise<void> {
    const entries = (await this.deps.registry.list()).filter(isDesktopSession);
    this.running = bestByHost(entries, this.deps.probe);
    this.available = new Map([...this.running].map(([id, e]) => [id, isAvailable(e, this.deps.probe)]));
    for (const [id, e] of this.running) this.lastSeen.set(id, { name: displayName({ name: e.name, sessionId: shortHostId(id) }), cwd: e.cwd, cli: e.sessionId });
  }

  private async readStore(): Promise<void> {
    let list: DesktopSession[] | null;
    try {
      list = await this.deps.store.list();
    } catch {
      list = null;
    }
    this.storeOk = list !== null;
    this.stored = new Map((list ?? []).map((s) => [s.hostSessionId, s]));
  }

  private async loadLastRequests(ids: readonly string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        const fallback = this.running.get(id)?.statusUpdatedAt ?? this.stored.get(id)?.lastActivityAt ?? null;
        const cli = this.cliIdOf(id);
        if (cli === undefined) {
          this.lastReq.set(id, fallback);
          return;
        }
        try {
          const last = await this.deps.transcripts.peekLastRequest(cli);
          this.lastReq.set(id, last ?? fallback);
        } catch {
          this.lastReq.set(id, fallback);
        }
      }),
    );
  }
}
