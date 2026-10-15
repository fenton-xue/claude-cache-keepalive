/** 目录归属、标题、会话排序。全部是纯函数。 */

export function normalizePath(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

export function baseName(p: string): string {
  const n = normalizePath(p);
  return n === '/' ? '/' : (n.split('/').filter(Boolean).pop() ?? n);
}

function parentName(p: string): string {
  const parts = normalizePath(p).split('/').filter(Boolean);
  return parts.length >= 2 ? (parts[parts.length - 2] as string) : '/';
}

/** cwd 等于目录或位于其子目录下（按路径边界，/a/bc 不属于 /a/b） */
export function isWithin(cwd: string, dir: string): boolean {
  const c = normalizePath(cwd);
  const d = normalizePath(dir);
  if (d === '/') return c.startsWith('/');
  return c === d || c.startsWith(d + '/');
}

/** 会话归属：路径最长（最深）的已添加目录；都不属于返回 null */
export function ownerOf(cwd: string, dirPaths: readonly string[]): string | null {
  let best: string | null = null;
  for (const d of dirPaths) {
    if (isWithin(cwd, d) && (best === null || normalizePath(d).length > normalizePath(best).length)) best = d;
  }
  return best;
}

/** cwd 与所属目录不同时返回相对路径，相同返回空串 */
export function subPath(cwd: string, dir: string): string {
  const c = normalizePath(cwd);
  const d = normalizePath(dir);
  if (c === d) return '';
  return d === '/' ? c.slice(1) : c.slice(d.length + 1);
}

/** 只显示最后一级文件夹名；最后一级同名的目录追加上一级目录名 */
export function dirLabels(dirPaths: readonly string[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const p of dirPaths) count.set(baseName(p), (count.get(baseName(p)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const p of dirPaths) {
    const b = baseName(p);
    out.set(p, (count.get(b) ?? 0) > 1 ? `${b}（${parentName(p)}）` : b);
  }
  return out;
}

/**
 * 目录内会话顺序。resort 为 true（启动、刷新、添加目录）时按最后请求时间从新到旧重排；
 * 否则保持上次顺序：已有的保持原位，消失的去掉，新出现的按时间从新到旧接在末尾。
 */
export function stableOrder(
  prev: readonly string[] | undefined,
  members: readonly { id: string; lastRequestAt: number | null }[],
  resort: boolean,
): string[] {
  const byTimeDesc = (a: { lastRequestAt: number | null }, b: { lastRequestAt: number | null }) =>
    (b.lastRequestAt ?? -Infinity) - (a.lastRequestAt ?? -Infinity);
  if (resort || !prev) return [...members].sort(byTimeDesc).map((m) => m.id);
  const ids = new Set(members.map((m) => m.id));
  const kept = prev.filter((id) => ids.has(id));
  const keptSet = new Set(kept);
  const added = members.filter((m) => !keptSet.has(m.id)).sort(byTimeDesc).map((m) => m.id);
  return [...kept, ...added];
}
