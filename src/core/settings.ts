export const CACHE_TTL_MS = 5 * 60 * 1000;
export const MIN_INTERVAL_SEC = 60;
export const MAX_INTERVAL_SEC = 290;
export const DEFAULT_INTERVAL_SEC = 270;
export const DEFAULT_CONTENT = '1';
/** 连续保活的总时长上限（秒） */
export const STREAK_WINDOW_SEC = 7200;
export const SEND_TIMEOUT_MS = 30_000;

export interface DirSetting {
  path: string;
  collapsed: boolean;
}

export interface Settings {
  content: string;
  intervalSec: number;
  dirs: DirSetting[];
}

export function defaultSettings(): Settings {
  return { content: DEFAULT_CONTENT, intervalSec: DEFAULT_INTERVAL_SEC, dirs: [] };
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
  if (Array.isArray(r.dirs)) {
    const seen = new Set<string>();
    for (const d of r.dirs) {
      if (typeof d !== 'object' || d === null) continue;
      const p = (d as Record<string, unknown>).path;
      if (typeof p !== 'string' || p === '' || seen.has(p)) continue;
      seen.add(p);
      out.dirs.push({ path: p, collapsed: (d as Record<string, unknown>).collapsed === true });
    }
  }
  return out;
}
