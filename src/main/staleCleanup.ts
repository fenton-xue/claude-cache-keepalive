import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OWN_NAME } from '../core/sessions';

export interface CleanupOptions {
  sessionsDir: string;
  socketDir: string;
  isPidAlive: (pid: number) => boolean;
  ownPid: number;
}

/**
 * 清理上次崩溃遗留的本程序注册项：进程已不存在、name 为 Claude Cache Keepalive、entrypoint 为 cli。
 * 删除 <pid>.json、<pid>.<64位十六进制>.key、<socketDir>/<pid>.sock。其他条目一律不碰。
 * 返回被删除的路径。
 */
export function cleanupStale(opts: CleanupOptions): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(opts.sessionsDir);
  } catch {
    return removed;
  }
  for (const n of names) {
    const m = /^(\d+)\.json$/.exec(n);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === opts.ownPid || opts.isPidAlive(pid)) continue;
    const file = join(opts.sessionsDir, n);
    let raw: { pid?: unknown; name?: unknown; entrypoint?: unknown };
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (raw.name !== OWN_NAME || raw.entrypoint !== 'cli' || raw.pid !== pid) continue;

    const targets = [file, join(opts.socketDir, `${pid}.sock`)];
    const keyRe = new RegExp(`^${pid}\\.[0-9a-f]{64}\\.key$`);
    for (const k of names) if (keyRe.test(k)) targets.push(join(opts.sessionsDir, k));
    for (const t of targets) {
      rmSync(t, { force: true });
      removed.push(t);
    }
  }
  return removed;
}
