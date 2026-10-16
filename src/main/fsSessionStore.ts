import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopSession, SessionStore } from '../core/types';

/** 把桌面版会话存储里一个 local_*.json 的内容整理成 DesktopSession；缺必需字段返回 null */
export function parseDesktopSession(raw: unknown): DesktopSession | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.sessionId !== 'string' || !r.sessionId.startsWith('local_') || typeof r.cwd !== 'string') return null;
  const s: DesktopSession = {
    hostSessionId: r.sessionId,
    title: typeof r.title === 'string' ? r.title : '',
    cwd: r.cwd,
    archived: r.isArchived === true,
    lastActivityAt: typeof r.lastActivityAt === 'number' ? r.lastActivityAt : typeof r.createdAt === 'number' ? r.createdAt : 0,
  };
  if (typeof r.cliSessionId === 'string' && r.cliSessionId !== '') s.cliSessionId = r.cliSessionId;
  return s;
}

/**
 * 只读：枚举 <root>/<账号>/<组织>/local_*.json。roots 通常是 Application Support 下
 * Claude 和 Claude-3p 的 claude-code-sessions。所有 root 都不存在，或找到了文件却一个都解析不了
 * （格式变化）时返回 null，调用方据此降级。
 */
export class FsSessionStore implements SessionStore {
  constructor(private readonly roots: readonly string[]) {}

  async list(): Promise<DesktopSession[] | null> {
    const out = new Map<string, DesktopSession>();
    let rootFound = false;
    let filesSeen = 0;
    for (const root of this.roots) {
      for (const dir of subdirs(root, (found) => (rootFound = rootFound || found))) {
        for (const sub of subdirs(dir)) {
          let names: string[];
          try {
            names = readdirSync(sub).filter((n) => /^local_.+\.json$/.test(n));
          } catch {
            continue;
          }
          for (const n of names) {
            filesSeen++;
            try {
              const s = parseDesktopSession(JSON.parse(readFileSync(join(sub, n), 'utf8')));
              const cur = s && out.get(s.hostSessionId);
              if (s && (!cur || s.lastActivityAt > cur.lastActivityAt)) out.set(s.hostSessionId, s);
            } catch {
              // 正在被写入，下一次再读
            }
          }
        }
      }
    }
    if (!rootFound || (filesSeen > 0 && out.size === 0)) return null;
    return [...out.values()];
  }
}

/** 列出 dir 下的子目录路径；dir 不存在返回空，并通过 onFound 告知是否存在 */
function subdirs(dir: string, onFound?: (found: boolean) => void): string[] {
  try {
    const ents = readdirSync(dir, { withFileTypes: true });
    onFound?.(true);
    return ents.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}
