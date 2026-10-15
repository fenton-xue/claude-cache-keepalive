import { dirLabels, ownerOf, stableOrder, subPath } from './directories';
import type { SendResult } from './format';
import { countdownMs, type Mode, type MonitorState } from './monitor';
import { bestBySessionId, displayName, isAvailable, isDesktopSession } from './sessions';
import { CACHE_TTL_MS, streakCap, type DirSetting } from './settings';
import type { Clock, RegistryEntry, SessionRegistry, SessionStatus, SystemProbe, TranscriptSource } from './types';

interface Known {
  entry: RegistryEntry;
  available: boolean;
  lastRequestAt: number | null;
}

export type RowMode = 'off' | 'unavailable' | Mode;

export interface SessionRowView {
  sessionId: string;
  name: string;
  shortId: string;
  /** cwd 与所属目录不同（如 worktree）时的相对路径，否则空串 */
  subPath: string;
  cwd: string;
  status: SessionStatus | undefined;
  available: boolean;
  checked: boolean;
  mode: RowMode;
  /** 监控中且会话非空闲：到点也不发送，等变为空闲 */
  waitingIdle: boolean;
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

export interface CatalogDeps {
  registry: SessionRegistry;
  probe: SystemProbe;
  transcripts: TranscriptSource;
  clock: Clock;
}

/**
 * 会话列表的内存模型：
 * - 成员只在 refresh（启动、手动刷新、添加目录）时重新读取，新开的会话刷新后才出现；
 * - tick 只更新已知成员的状态、可用性和最后请求时间，不改变成员和顺序；
 * - 会话退出后成员仍保留（标为不可用），直到下一次 refresh 才移除。
 */
export class Catalog {
  private readonly known = new Map<string, Known>();
  private readonly orders = new Map<string, string[]>();
  private resortNext = true;

  constructor(private readonly deps: CatalogDeps) {}

  async refresh(): Promise<void> {
    const entries = (await this.deps.registry.list()).filter(isDesktopSession);
    const next = new Map<string, Known>();
    for (const [id, entry] of bestBySessionId(entries, this.deps.probe)) {
      next.set(id, { entry, available: isAvailable(entry, this.deps.probe), lastRequestAt: null });
    }
    this.known.clear();
    for (const [id, k] of next) this.known.set(id, k);
    await this.loadLastRequests([...this.known.keys()]);
    this.resortNext = true;
  }

  /** 更新已知成员的实时数据。dirs 之外的会话不读取记录文件。 */
  async tick(dirPaths: readonly string[]): Promise<void> {
    const entries = (await this.deps.registry.list()).filter(isDesktopSession);
    const live = bestBySessionId(entries, this.deps.probe);
    for (const [id, k] of this.known) {
      const e = live.get(id);
      if (e) {
        k.entry = e;
        k.available = isAvailable(e, this.deps.probe);
      } else {
        k.available = false;
      }
    }
    const visible = [...this.known.values()]
      .filter((k) => ownerOf(k.entry.cwd, dirPaths) !== null)
      .map((k) => k.entry.sessionId);
    await this.loadLastRequests(visible);
  }

  /** 目录增删后下一次 view 需要按时间重排（添加目录时调用） */
  requestResort(): void {
    this.resortNext = true;
  }

  /** 归属于某个目录的全部已知会话（不影响排序状态） */
  sessionIdsIn(dirPaths: readonly string[], dir: string): string[] {
    return [...this.known.values()].filter((k) => ownerOf(k.entry.cwd, dirPaths) === dir).map((k) => k.entry.sessionId);
  }

  view(dirs: readonly DirSetting[], states: ReadonlyMap<string, MonitorState>, intervalSec: number): GroupView[] {
    const now = this.deps.clock.now();
    const paths = dirs.map((d) => d.path);
    const labels = dirLabels(paths);
    const cap = streakCap(intervalSec);
    const resort = this.resortNext;
    this.resortNext = false;

    const byOwner = new Map<string, Known[]>();
    for (const k of this.known.values()) {
      const owner = ownerOf(k.entry.cwd, paths);
      if (owner === null) continue;
      const list = byOwner.get(owner) ?? [];
      list.push(k);
      byOwner.set(owner, list);
    }

    return dirs.map((d, i): GroupView => {
      const members = byOwner.get(d.path) ?? [];
      const st = (k: Known) => states.get(k.entry.sessionId);
      const order = stableOrder(
        this.orders.get(d.path),
        members.map((k) => ({
          id: k.entry.sessionId,
          lastRequestAt: st(k)?.lastRequestAt ?? k.lastRequestAt,
        })),
        resort,
      );
      this.orders.set(d.path, order);
      const rows = order.map((id) => {
        const k = this.known.get(id) as Known;
        return this.row(k, d.path, st(k), now, intervalSec, cap);
      });
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

  private row(k: Known, dir: string, s: MonitorState | undefined, now: number, intervalSec: number, cap: number): SessionRowView {
    const e = k.entry;
    const checked = s !== undefined && s.mode !== 'gone';
    const lastRequestAt = s?.lastRequestAt ?? k.lastRequestAt;
    const ageMs = lastRequestAt === null ? null : Math.max(0, now - lastRequestAt);
    const mode: RowMode = s ? s.mode : k.available ? 'off' : 'unavailable';
    return {
      sessionId: e.sessionId,
      name: displayName(e),
      shortId: e.sessionId.slice(0, 8),
      subPath: subPath(e.cwd, dir),
      cwd: e.cwd,
      status: e.status,
      available: k.available,
      checked,
      mode,
      waitingIdle: mode === 'watching' && e.status !== undefined && e.status !== 'idle',
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

  private async loadLastRequests(ids: readonly string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        const k = this.known.get(id);
        if (!k) return;
        try {
          const last = await this.deps.transcripts.peekLast(id);
          k.lastRequestAt = last?.timestamp ?? k.entry.statusUpdatedAt ?? null;
        } catch {
          k.lastRequestAt = k.entry.statusUpdatedAt ?? null;
        }
      }),
    );
  }
}
