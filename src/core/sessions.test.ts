import { describe, expect, it } from 'vitest';
import { bestByHost, bestBySessionId, displayName, findBySessionId, isAvailable, isDesktopSession, parseRegistryEntry, shortHostId } from './sessions';
import { FakeRegistry } from './testing/fakes';

const raw = {
  pid: 97849,
  sessionId: '6e8d4425-1853-4e73-a4da-6cf45a68a024',
  cwd: '/w',
  entrypoint: 'claude-desktop-3p',
  messagingSocketPath: '/tmp/cc-socks/97849.sock',
  status: 'idle',
  statusUpdatedAt: 5,
  updatedAt: 6,
  name: 'n',
  hostSessionId: 'local_054fbaf1-430e-492d-8a02-141d04286b43',
  extra: 1,
};

describe('parseRegistryEntry', () => {
  it('取出需要的字段', () => {
    expect(parseRegistryEntry(raw)).toEqual({
      pid: 97849,
      sessionId: raw.sessionId,
      cwd: '/w',
      entrypoint: 'claude-desktop-3p',
      messagingSocketPath: '/tmp/cc-socks/97849.sock',
      status: 'idle',
      statusUpdatedAt: 5,
      updatedAt: 6,
      name: 'n',
      hostSessionId: 'local_054fbaf1-430e-492d-8a02-141d04286b43',
    });
  });
  it('缺必需字段返回 null，未知 status 丢弃', () => {
    expect(parseRegistryEntry({ ...raw, pid: undefined })).toBeNull();
    expect(parseRegistryEntry({ ...raw, messagingSocketPath: 1 })).toBeNull();
    expect(parseRegistryEntry(null)).toBeNull();
    expect(parseRegistryEntry({ ...raw, status: 'weird' })?.status).toBeUndefined();
  });
});

describe('isDesktopSession', () => {
  it('没有 hostSessionId 的不算桌面版会话，会话号去掉 local_ 前缀取前 8 位', () => {
    const { hostSessionId: _h, ...rest } = raw;
    expect(isDesktopSession(parseRegistryEntry(rest) as never)).toBe(false);
    expect(parseRegistryEntry({ ...raw, hostSessionId: '' })?.hostSessionId).toBeUndefined();
    expect(shortHostId('local_054fbaf1-430e-492d')).toBe('054fbaf1');
    expect(shortHostId('abcdefghijkl')).toBe('abcdefgh');
  });
  it('只保留 claude-desktop 系列', () => {
    expect(isDesktopSession({ ...(parseRegistryEntry(raw) as object) } as never)).toBe(true);
    expect(isDesktopSession({ ...(parseRegistryEntry(raw) as object), entrypoint: 'cli' } as never)).toBe(false);
    expect(isDesktopSession({ ...(parseRegistryEntry(raw) as object), entrypoint: 'claude-desktop' } as never)).toBe(true);
  });
  it('排除本程序自己的注册项', () => {
    const own = { ...(parseRegistryEntry(raw) as object), name: 'Keepwarm', entrypoint: 'cli' };
    expect(isDesktopSession(own as never)).toBe(false);
    expect(isDesktopSession({ ...own, name: 'Claude Cache Keepalive' } as never)).toBe(false);
  });
});

describe('可用性与查找', () => {
  it('套接字不在或进程已退出都不可用', () => {
    const reg = new FakeRegistry();
    const e = reg.add({ sessionId: 's1', pid: 1 });
    expect(isAvailable(e, reg)).toBe(true);
    reg.missingSockets.add(e.messagingSocketPath);
    expect(isAvailable(e, reg)).toBe(false);
    reg.missingSockets.clear();
    reg.deadPids.add(1);
    expect(isAvailable(e, reg)).toBe(false);
  });
  it('名称缺失时用会话号前 8 位', () => {
    expect(displayName({ sessionId: '6e8d4425-1853' })).toBe('6e8d4425');
    expect(displayName({ sessionId: 'x', name: 'abc' })).toBe('abc');
    expect(displayName({ sessionId: '6e8d4425-1853', name: ' ' })).toBe('6e8d4425');
  });
  it('同一 sessionId 有残留旧项时优先可用的，其次最新的', () => {
    const reg = new FakeRegistry();
    reg.add({ sessionId: 's', pid: 1, updatedAt: 100 });
    reg.add({ sessionId: 's', pid: 2, updatedAt: 50 });
    reg.add({ sessionId: 's', pid: 3, updatedAt: 200 });
    reg.deadPids.add(3);
    expect(findBySessionId(reg.entries, 's', reg)?.pid).toBe(1);
    expect(bestBySessionId(reg.entries, reg).get('s')?.pid).toBe(1);
    expect(findBySessionId(reg.entries, 'none', reg)).toBeUndefined();
  });
  it('同一桌面版会话（hostSessionId）CLI 会话号变了时，各留一个：可用的优先，其次最新的', () => {
    const reg = new FakeRegistry();
    reg.add({ sessionId: 'cli-old', pid: 1, hostSessionId: 'local_h', updatedAt: 100 });
    reg.add({ sessionId: 'cli-new', pid: 2, hostSessionId: 'local_h', updatedAt: 200 });
    reg.add({ sessionId: 'other', pid: 3, hostSessionId: 'local_o' });
    expect(bestByHost(reg.entries, reg).get('local_h')?.sessionId).toBe('cli-new');
    reg.deadPids.add(2);
    expect(bestByHost(reg.entries, reg).get('local_h')?.sessionId).toBe('cli-old');
    expect(bestByHost(reg.entries, reg).size).toBe(2);
  });
});
