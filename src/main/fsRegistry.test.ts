import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsProbe, FsRegistry } from './fsRegistry';

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'keepalive-reg-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('FsRegistry', () => {
  it('读取注册文件，跳过密钥文件、损坏文件和字段不全的文件', async () => {
    const ok = { pid: 1, sessionId: 's1', cwd: '/w', entrypoint: 'claude-desktop-3p', messagingSocketPath: '/tmp/cc-socks/1.sock', status: 'idle' };
    writeFileSync(join(dir, '1.json'), JSON.stringify(ok));
    writeFileSync(join(dir, `1.${'a'.repeat(64)}.key`), '{}');
    writeFileSync(join(dir, '2.json'), '{broken');
    writeFileSync(join(dir, '3.json'), JSON.stringify({ pid: 3 }));
    const list = await new FsRegistry(dir).list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pid: 1, sessionId: 's1', status: 'idle' });
  });
  it('目录不存在返回空列表', async () => {
    expect(await new FsRegistry(join(dir, 'nope')).list()).toEqual([]);
  });
});

describe('FsProbe', () => {
  it('当前进程存活，不存在的 pid 不存活', () => {
    const p = new FsProbe();
    expect(p.isPidAlive(process.pid)).toBe(true);
    expect(p.isPidAlive(2 ** 22 + 12345)).toBe(false);
  });
  it('普通文件不算套接字，不存在也不算', () => {
    const p = new FsProbe();
    writeFileSync(join(dir, 'f'), '');
    expect(p.socketExists(join(dir, 'f'))).toBe(false);
    expect(p.socketExists(join(dir, 'none'))).toBe(false);
  });
});
