import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsSessionStore, parseDesktopSession } from './fsSessionStore';

describe('parseDesktopSession', () => {
  it('取出需要的字段，isArchived 缺失按未归档', () => {
    expect(
      parseDesktopSession({ sessionId: 'local_1', cliSessionId: 'cli', title: 'T', cwd: '/w', isArchived: true, lastActivityAt: 5, extra: 1 }),
    ).toEqual({ hostSessionId: 'local_1', cliSessionId: 'cli', title: 'T', cwd: '/w', archived: true, lastActivityAt: 5 });
    expect(parseDesktopSession({ sessionId: 'local_1', cwd: '/w', createdAt: 9 })).toEqual({
      hostSessionId: 'local_1',
      title: '',
      cwd: '/w',
      archived: false,
      lastActivityAt: 9,
    });
  });
  it('缺必需字段或 id 不是 local_ 开头返回 null', () => {
    expect(parseDesktopSession({ sessionId: 'x', cwd: '/w' })).toBeNull();
    expect(parseDesktopSession({ sessionId: 'local_1' })).toBeNull();
    expect(parseDesktopSession(null)).toBeNull();
  });
});

describe('FsSessionStore', () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'kw-store-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const put = (root: string, acct: string, org: string, file: string, body: unknown) => {
    const d = join(dir, root, acct, org);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, file), typeof body === 'string' ? body : JSON.stringify(body));
  };

  it('读取 <root>/<账号>/<组织>/local_*.json，多个 root 合并，同 id 取更新的', async () => {
    put('Claude-3p', 'acct', 'org', 'local_a.json', { sessionId: 'local_a', cwd: '/w', title: 'A', lastActivityAt: 1 });
    put('Claude-3p', 'acct', 'org', 'local_b.json', { sessionId: 'local_b', cwd: '/w', title: 'B', isArchived: true, lastActivityAt: 2 });
    put('Claude', 'acct', 'org', 'local_a.json', { sessionId: 'local_a', cwd: '/w', title: 'A新', lastActivityAt: 9 });
    put('Claude-3p', 'acct', 'org', 'other.json', { sessionId: 'local_z', cwd: '/w' }); // 文件名不匹配
    const list = (await new FsSessionStore([join(dir, 'Claude'), join(dir, 'Claude-3p')]).list())!;
    expect(list.map((s) => [s.hostSessionId, s.title, s.archived]).sort()).toEqual([
      ['local_a', 'A新', false],
      ['local_b', 'B', true],
    ]);
  });

  it('单个文件损坏被跳过', async () => {
    put('C', 'a', 'o', 'local_a.json', { sessionId: 'local_a', cwd: '/w' });
    put('C', 'a', 'o', 'local_bad.json', '{not json');
    expect((await new FsSessionStore([join(dir, 'C')]).list())!.map((s) => s.hostSessionId)).toEqual(['local_a']);
  });

  it('目录不存在返回 null；目录在但没有会话文件返回空数组；有文件却全部解析不了返回 null', async () => {
    expect(await new FsSessionStore([join(dir, 'nope')]).list()).toBeNull();
    mkdirSync(join(dir, 'Empty', 'a', 'o'), { recursive: true });
    expect(await new FsSessionStore([join(dir, 'Empty')]).list()).toEqual([]);
    put('Weird', 'a', 'o', 'local_x.json', { format: 'changed' });
    expect(await new FsSessionStore([join(dir, 'Weird')]).list()).toBeNull();
  });
});
