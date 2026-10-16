export const CACHE_TTL_MS = 5 * 60 * 1000;
/** 会话忙碌时，距上次请求达到这个时长就提醒：缓存还有 30 秒失效，但忙碌中无法保活 */
export const STALL_WARN_MS = CACHE_TTL_MS - 30_000;
export const MIN_INTERVAL_SEC = 60;
export const MAX_INTERVAL_SEC = 290;
export const DEFAULT_INTERVAL_SEC = 270;
export const DEFAULT_CONTENT = "Test message. Don't think. Reply 1.";
/** 连续保活的总时长上限（秒） */
export const STREAK_WINDOW_SEC = 7200;
export const SEND_TIMEOUT_MS = 30_000;

export interface DirSetting {
  path: string;
  collapsed: boolean;
  /** 用户手动添加到该工作区的会话（桌面版会话 id） */
  members: string[];
}

/** 设置文件的当前格式版本。低于它说明是 v1.3 及以前的文件，需要做一次成员迁移（需求 5.7） */
export const SETTINGS_SCHEMA = 2;

export interface Settings {
  schemaVersion: number;
  content: string;
  intervalSec: number;
  dirs: DirSetting[];
  /** 记住的勾选集合（桌面版会话 id），重启后恢复监控（需求 6.4） */
  checked: string[];
}

export function defaultSettings(): Settings {
  return { schemaVersion: SETTINGS_SCHEMA, content: DEFAULT_CONTENT, intervalSec: DEFAULT_INTERVAL_SEC, dirs: [], checked: [] };
}

/** 连续成功次数上限 = floor(7200 / 间隔秒数) */
export function streakCap(intervalSec: number): number {
  return Math.floor(STREAK_WINDOW_SEC / intervalSec);
}

/** 解析 "4:30" 或纯秒数 "270"；格式不对返回 null（范围另由 validateInterval 判断） */
export function parseInterval(text: string): number | null {
  const t = text.trim();
  let m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m) {
    const sec = Number(m[2]);
    return sec < 60 ? Number(m[1]) * 60 + sec : null;
  }
  m = /^(\d{1,4})$/.exec(t);
  return m ? Number(m[1]) : null;
}

export function formatInterval(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** 返回错误提示；合法返回 null */
export function validateInterval(sec: number | null): string | null {
  if (sec === null || !Number.isInteger(sec) || sec < MIN_INTERVAL_SEC || sec > MAX_INTERVAL_SEC) {
    return `间隔需在 ${formatInterval(MIN_INTERVAL_SEC)} 到 ${formatInterval(MAX_INTERVAL_SEC)} 之间，格式如 4:30。`;
  }
  return null;
}

export function validateContent(text: string): string | null {
  return text.trim() === '' ? '发送内容不能为空。' : null;
}

/** 从磁盘读到的任意内容整理成合法设置，坏字段回退默认值，目录去重 */
export function normalizeSettings(raw: unknown): Settings {
  const out = defaultSettings();
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.content === 'string' && validateContent(r.content) === null) out.content = r.content.trim();
  if (typeof r.intervalSec === 'number' && validateInterval(r.intervalSec) === null) out.intervalSec = r.intervalSec;
  if (r.schemaVersion !== SETTINGS_SCHEMA) out.schemaVersion = 1;
  const strings = (v: unknown, seen: Set<string>): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '' && !seen.has(x) && !!seen.add(x)) : [];
  if (Array.isArray(r.dirs)) {
    const seen = new Set<string>();
    const seenMembers = new Set<string>(); // 一个会话只属于一个工作区
    for (const d of r.dirs) {
      if (typeof d !== 'object' || d === null) continue;
      const rd = d as Record<string, unknown>;
      const p = rd.path;
      if (typeof p !== 'string' || p === '' || seen.has(p)) continue;
      seen.add(p);
      out.dirs.push({ path: p, collapsed: rd.collapsed === true, members: strings(rd.members, seenMembers) });
    }
  }
  const members = new Set(out.dirs.flatMap((d) => d.members));
  out.checked = strings(r.checked, new Set()).filter((id) => members.has(id));
  return out;
}
