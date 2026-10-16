import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeSettings, type Settings } from '../core/settings';

/** 设置存在 Electron 应用数据目录，写入时先写临时文件再改名 */
export class SettingsStore {
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, 'settings.json');
  }

  load(): Settings {
    try {
      return normalizeSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return normalizeSettings(null);
    }
  }

  save(s: Settings): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schemaVersion: s.schemaVersion, content: s.content, intervalSec: s.intervalSec, dirs: s.dirs, checked: s.checked }, null, 2));
    renameSync(tmp, this.file);
  }
}
