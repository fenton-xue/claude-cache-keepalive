import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupStale } from './staleCleanup';

const HASH = 'a'.repeat(64);
let root: string;
let sessions: string;
let socks: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'keepalive-clean-'));
  sessions = join(root, 'sessions');
  socks = join(root, 'socks');
  mkdirSync(sessions);
  mkdirSync(socks);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function entry(pid: number, over: Record<string, unknown> = {}, files = { key: true, sock: true }): void {
  writeFileSync(
    join(sessions, `${pid}.json`),
    JSON.stringify({ pid, sessionId: `s${pid}`, name: 'Keepwarm', entrypoint: 'cli', ...over }),
  );
  if (files.key) writeFileSync(join(sessions, `${pid}.${HASH}.key`), '{}');
  if (files.sock) writeFileSync(join(socks, `${pid}.sock`), '');
}

const run = (alive: number[], ownPid = 1) =>
  cleanupStale({ sessionsDir: sessions, socketDir: socks, isPidAlive: (p) => alive.includes(p), ownPid });

describe('cleanupStale', () => {
  it('删除进程已不存在的本程序条目：注册文件、密钥文件、套接字', () => {
    entry(100);
    const removed = run([]);
    expect(removed).toHaveLength(3);
    expect(readdirSync(sessions)).toEqual([]);
    expect(readdirSync(socks)).toEqual([]);
  });

  it('早期名字（Claude Cache Keepalive）留下的残留同样清理', () => {
    entry(100, { name: 'Claude Cache Keepalive' });
    expect(run([])).toHaveLength(3);
    expect(readdirSync(sessions)).toEqual([]);
  });

  it('进程还活着的不碰（含另一个正在运行的本程序）', () => {
    entry(100);
    expect(run([100])).toEqual([]);
    expect(readdirSync(sessions)).toHaveLength(2);
  });

  it('自己的 pid 不碰', () => {
    entry(100);
    expect(run([], 100)).toEqual([]);
    expect(existsSync(join(sessions, '100.json'))).toBe(true);
  });

  it('其他条目一律不碰：桌面版会话、其他名字的 cli 条目、内容损坏的文件', () => {
    entry(200, { name: 'someone', entrypoint: 'claude-desktop-3p' });
    entry(201, { name: 'Keepwarm', entrypoint: 'claude-desktop-3p' });
    entry(202, { name: 'other-cli', entrypoint: 'cli' });
    entry(203, { pid: 999 }); // 文件名与内容里的 pid 不一致
    writeFileSync(join(sessions, '204.json'), '{broken');
    writeFileSync(join(sessions, 'notes.txt'), 'x');
    const before = readdirSync(sessions).sort();
    const beforeSocks = readdirSync(socks).sort();
    expect(run([])).toEqual([]);
    expect(readdirSync(sessions).sort()).toEqual(before);
    expect(readdirSync(socks).sort()).toEqual(beforeSocks);
  });

  it('只删对应 pid 的密钥文件和套接字', () => {
    entry(100);
    entry(300, { name: 'x', entrypoint: 'claude-desktop-3p' });
    writeFileSync(join(sessions, `1000.${HASH}.key`), '{}'); // pid 前缀相近但不同
    run([]);
    expect(readdirSync(sessions).sort()).toEqual([`1000.${HASH}.key`, `300.${HASH}.key`, '300.json'].sort());
    expect(readdirSync(socks)).toEqual(['300.sock']);
  });

  it('目录不存在时不报错', () => {
    expect(cleanupStale({ sessionsDir: join(root, 'nope'), socketDir: socks, isPidAlive: () => false, ownPid: 1 })).toEqual([]);
  });
});
