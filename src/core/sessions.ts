import type { RegistryEntry, SessionStatus, SystemProbe } from './types';

export const OWN_NAME = 'Keepwarm';
/** 早期版本使用过的名字，启动清理残留时仍要认得 */
export const LEGACY_OWN_NAMES: readonly string[] = ['Claude Cache Keepalive'];

export function isOwnName(name: unknown): boolean {
  return name === OWN_NAME || (typeof name === 'string' && LEGACY_OWN_NAMES.includes(name));
}
const STATUSES: readonly string[] = ['idle', 'busy', 'waiting', 'shell'];

/** 把注册文件的 JSON 整理成 RegistryEntry；缺必需字段返回 null */
export function parseRegistryEntry(raw: unknown): RegistryEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.pid !== 'number' ||
    typeof r.sessionId !== 'string' ||
    typeof r.cwd !== 'string' ||
    typeof r.entrypoint !== 'string' ||
    typeof r.messagingSocketPath !== 'string'
  ) {
    return null;
  }
  const e: RegistryEntry = {
    pid: r.pid,
    sessionId: r.sessionId,
    cwd: r.cwd,
    entrypoint: r.entrypoint,
    messagingSocketPath: r.messagingSocketPath,
  };
  if (typeof r.hostSessionId === 'string' && r.hostSessionId !== '') e.hostSessionId = r.hostSessionId;
  if (typeof r.name === 'string') e.name = r.name;
  if (typeof r.status === 'string' && STATUSES.includes(r.status)) e.status = r.status as SessionStatus;
  if (typeof r.statusUpdatedAt === 'number') e.statusUpdatedAt = r.statusUpdatedAt;
  if (typeof r.updatedAt === 'number') e.updatedAt = r.updatedAt;
  return e;
}

/** 桌面版会话（entrypoint 为 claude-desktop 系列且带 hostSessionId），排除本程序自己的注册项 */
export function isDesktopSession(e: RegistryEntry): boolean {
  if (isOwnName(e.name) && e.entrypoint === 'cli') return false;
  return e.entrypoint.startsWith('claude-desktop') && e.hostSessionId !== undefined;
}

/** 界面显示的会话号：桌面版会话 id 去掉 local_ 前缀后的前 8 位 */
export function shortHostId(hostSessionId: string): string {
  return hostSessionId.replace(/^local_/, '').slice(0, 8);
}

/** 套接字文件存在且进程还活着 */
export function isAvailable(e: RegistryEntry, probe: SystemProbe): boolean {
  return probe.isPidAlive(e.pid) && probe.socketExists(e.messagingSocketPath);
}

export function displayName(e: Pick<RegistryEntry, 'name' | 'sessionId'>): string {
  return e.name && e.name.trim() !== '' ? e.name : e.sessionId.slice(0, 8);
}

/**
 * 按 sessionId 找注册项。可能同时有多个（旧进程残留 + 新进程），
 * 优先取可用的，其次取 updatedAt 最新的。
 */
export function findBySessionId(
  entries: readonly RegistryEntry[],
  sessionId: string,
  probe: SystemProbe,
): RegistryEntry | undefined {
  return bestBySessionId(
    entries.filter((e) => e.sessionId === sessionId),
    probe,
  ).get(sessionId);
}

/** 每个 sessionId 只留一个注册项：优先可用的，其次 updatedAt 最新的 */
export function bestBySessionId(entries: readonly RegistryEntry[], probe: SystemProbe): Map<string, RegistryEntry> {
  const out = new Map<string, RegistryEntry>();
  for (const e of entries) {
    const cur = out.get(e.sessionId);
    if (!cur || better(e, cur, probe)) out.set(e.sessionId, e);
  }
  return out;
}

/** 每个桌面版会话（hostSessionId）只留一个注册项：优先可用的，其次 updatedAt 最新的 */
export function bestByHost(entries: readonly RegistryEntry[], probe: SystemProbe): Map<string, RegistryEntry> {
  const out = new Map<string, RegistryEntry>();
  for (const e of entries) {
    if (e.hostSessionId === undefined) continue;
    const cur = out.get(e.hostSessionId);
    if (!cur || better(e, cur, probe)) out.set(e.hostSessionId, e);
  }
  return out;
}

function better(a: RegistryEntry, b: RegistryEntry, probe: SystemProbe): boolean {
  const av = isAvailable(a, probe) ? 1 : 0;
  const bv = isAvailable(b, probe) ? 1 : 0;
  return av !== bv ? av > bv : (a.updatedAt ?? 0) > (b.updatedAt ?? 0);
}
