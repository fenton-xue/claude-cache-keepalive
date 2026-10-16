import { net, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, appendFileSync, constants, createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { RELEASE_API, UpdateHttpError, type ReleaseAsset } from '../core/update';
import type { UpdateIo } from './updater';

const run = promisify(execFile);

/**
 * 把新版本换进当前 .app 的后台脚本：等本程序退出 → 旧版改名备份 → 新版改名到原位 → 去掉隔离属性 → 启动。
 * 任何一步失败就把备份改回原位并启动旧版。路径变量全部带 :? 守卫。
 */
const SWAP_SCRIPT = `#!/bin/sh
pid="$1"; target="$2"; staged="$3"; backup="$4"; log="$5"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1)); [ "$i" -gt 150 ] && break
  sleep 0.2
done
rm -rf -- "\${backup:?}"
if mv -- "\${target:?}" "\${backup:?}" && mv -- "\${staged:?}" "\${target:?}"; then
  xattr -dr com.apple.quarantine "$target" 2>/dev/null
  echo "$(date '+%F %T') 安装成功" >> "$log"
  open "$target"
  rm -rf -- "\${backup:?}"
else
  echo "$(date '+%F %T') 安装失败，已还原旧版本" >> "$log"
  [ -e "$target" ] || mv -- "\${backup:?}" "\${target:?}"
  rm -rf -- "\${staged:?}"
  open "$target"
fi
`;

/** 当前 .app 的路径：<…>/Keepwarm.app/Contents/MacOS/Keepwarm 往上三级；不是 .app 形态返回 null */
export function currentAppPath(exePath: string): string | null {
  const app = dirname(dirname(dirname(exePath)));
  return app.endsWith('.app') ? app : null;
}

export class ElectronUpdateIo implements UpdateIo {
  private workDir: string | null = null;

  constructor(
    private readonly exePath: string,
    private readonly userDataDir: string,
  ) {}

  async fetchLatest(signal: AbortSignal): Promise<unknown> {
    const res = await net.fetch(RELEASE_API, {
      signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Keepwarm' },
    });
    if (!res.ok) throw new UpdateHttpError(res.status);
    return res.json();
  }

  async fetchText(url: string, signal: AbortSignal): Promise<string> {
    const res = await net.fetch(url, { signal, headers: { 'User-Agent': 'Keepwarm' } });
    if (!res.ok) throw new UpdateHttpError(res.status);
    return res.text();
  }

  async download(
    asset: ReleaseAsset,
    signal: AbortSignal,
    onProgress: (received: number, total: number | undefined) => void,
  ): Promise<{ path: string; sha256: string }> {
    this.discard();
    const dir = mkdtempSync(join(tmpdir(), 'keepwarm-update-'));
    this.workDir = dir;
    const path = join(dir, basename(asset.name));
    const res = await net.fetch(asset.url, { signal, headers: { 'User-Agent': 'Keepwarm' } });
    if (!res.ok || !res.body) throw new UpdateHttpError(res.status);
    const len = Number(res.headers.get('content-length'));
    const total = Number.isFinite(len) && len > 0 ? len : undefined;
    const hash = createHash('sha256');
    const out = createWriteStream(path);
    let received = 0;
    let lastReport = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.length;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', r));
        const now = Date.now();
        if (now - lastReport > 100) {
          lastReport = now;
          onProgress(received, total);
        }
      }
      onProgress(received, total);
    } finally {
      await new Promise<void>((r) => out.end(r));
    }
    return { path, sha256: hash.digest('hex') };
  }

  discard(): void {
    if (this.workDir) rmSync(this.workDir, { recursive: true, force: true });
    this.workDir = null;
  }

  async install(dmgPath: string, version: string): Promise<'restarting' | 'manual'> {
    const target = currentAppPath(this.exePath);
    if (!target) throw new Error('当前不是以应用包形式运行，无法确定安装位置');
    const parent = dirname(target);
    try {
      accessSync(parent, constants.W_OK);
    } catch {
      await shell.openPath(dmgPath); // 没有写权限：降级为让用户手动拖入
      this.log(`没有写权限（${parent}），已打开安装包让用户手动安装`);
      this.workDir = null; // dmg 要留给用户，不再清理
      return 'manual';
    }

    const staged = join(parent, '.Keepwarm.update.app');
    const backup = join(parent, '.Keepwarm.backup.app');
    const mount = mkdtempSync(join(tmpdir(), 'keepwarm-mount-'));
    try {
      await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmgPath]);
      try {
        rmSync(staged, { recursive: true, force: true });
        await run('ditto', [join(mount, 'Keepwarm.app'), staged]);
      } finally {
        await run('hdiutil', ['detach', mount, '-force']).catch(() => undefined);
      }
      try {
        await run('codesign', ['--verify', '--deep', '--strict', staged]);
      } catch {
        rmSync(staged, { recursive: true, force: true });
        throw new Error('新版本签名异常，已取消安装');
      }
    } finally {
      rmSync(mount, { recursive: true, force: true });
    }

    const scriptDir = mkdtempSync(join(tmpdir(), 'keepwarm-swap-'));
    const script = join(scriptDir, 'swap.sh');
    writeFileSync(script, SWAP_SCRIPT);
    const logFile = join(this.userDataDir, 'update.log');
    this.log(`开始安装 v${version}`);
    spawn('/bin/sh', [script, String(process.pid), target, staged, backup, logFile], { detached: true, stdio: 'ignore' }).unref();
    return 'restarting';
  }

  private log(msg: string): void {
    try {
      mkdirSync(this.userDataDir, { recursive: true });
      appendFileSync(join(this.userDataDir, 'update.log'), `${new Date().toISOString()} ${msg}\n`);
    } catch {
      // 日志写不了不影响更新
    }
  }
}
