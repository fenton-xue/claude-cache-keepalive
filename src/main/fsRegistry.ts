import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseRegistryEntry } from '../core/sessions';
import type { RegistryEntry, SessionRegistry, SystemProbe } from '../core/types';

/** 只读：枚举 ~/.claude/sessions/*.json，读不了或格式不对的文件直接跳过 */
export class FsRegistry implements SessionRegistry {
  constructor(private readonly sessionsDir: string) {}

  async list(): Promise<RegistryEntry[]> {
    let names: string[];
    try {
      names = readdirSync(this.sessionsDir);
    } catch {
      return [];
    }
    const out: RegistryEntry[] = [];
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue;
      try {
        const e = parseRegistryEntry(JSON.parse(readFileSync(join(this.sessionsDir, n), 'utf8')));
        if (e) out.push(e);
      } catch {
        // 正在被写入或已被删除，下一轮再读
      }
    }
    return out;
  }
}

export class FsProbe implements SystemProbe {
  isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'; // 存在但无权限发信号
    }
  }

  socketExists(path: string): boolean {
    try {
      return statSync(path).isSocket();
    } catch {
      return false;
    }
  }
}
