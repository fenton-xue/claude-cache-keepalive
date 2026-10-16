import { describe, expect, it } from 'vitest';
import { Catalog } from './catalog';
import { Monitor } from './monitor';
import { FakeClock, FakeRegistry, FakeSender, FakeStore, FakeTranscripts, T0 } from './testing/fakes';
import type { DirSetting } from './settings';

const S = 1000;
const h = (id: string) => `local_${id}`;

function setup() {
  const clock = new FakeClock();
  const reg = new FakeRegistry();
  const store = new FakeStore();
  const tr = new FakeTranscripts();
  const sender = new FakeSender(clock, tr);
  const catalog = new Catalog({ registry: reg, store, probe: reg, transcripts: tr, clock });
  const mon = new Monitor({
    clock,
    registry: reg,
    probe: reg,
    transcripts: tr,
    sender,
    getSettings: () => ({ content: '1', intervalSec: 270 }),
    notify: () => undefined,
  });
  /** 一个工作区，成员是给定的会话（简写 id，自动加 local_ 前缀） */
  const dir = (path: string, ...members: string[]): DirSetting => ({ path, collapsed: false, members: members.map(h) });
  const view = (d: DirSetting[], pending: string[] = []) =>
    catalog.view(d, new Map(mon.states().map((s) => [s.sessionId, s])), 270, new Set(pending.map(h)));
  const ids = (d: DirSetting[]) => d.flatMap((x) => x.members);
  const refresh = (d: DirSetting[]) => catalog.refresh(ids(d));
  return { clock, reg, store, tr, catalog, mon, dir, view, refresh };
}

describe('Catalog 成员与分组', () => {
  it('成员由工作区设置决定，不按 cwd 自动纳入；子路径按 cwd 计算', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1, cwd: '/w/app' });
    c.reg.add({ sessionId: 'b', pid: 2, cwd: '/w/app/.claude/worktrees/ui' });
    c.reg.add({ sessionId: 'c', pid: 3, cwd: '/w/app' }); // 在目录里，但没添加
    const d = [c.dir('/w/app', 'a', 'b')];
    await c.refresh(d);
    const g = c.view(d)[0]!;
    expect(g.rows.map((r) => r.id).sort()).toEqual([h('a'), h('b')]);
    expect(g.rows.find((r) => r.id === h('a'))!.subPath).toBe('');
    expect(g.rows.find((r) => r.id === h('b'))!.subPath).toBe('.claude/worktrees/ui');
  });

  it('没有成员的工作区分组仍存在，行为空', async () => {
    const c = setup();
    const d = [c.dir('/empty')];
    await c.refresh(d);
    const v = c.view(d);
    expect(v).toHaveLength(1);
    expect(v[0]!.rows).toEqual([]);
    expect(v[0]!.label).toBe('empty');
  });

  it('上移下移按钮的可用性、折叠状态、同名标题', async () => {
    const c = setup();
    await c.refresh([]);
    const d: DirSetting[] = [
      { path: '/x/app', collapsed: true, members: [] },
      { path: '/y/app', collapsed: false, members: [] },
      { path: '/z', collapsed: false, members: [] },
    ];
    const v = c.view(d);
    expect(v.map((g) => [g.canMoveUp, g.canMoveDown])).toEqual([
      [false, true],
      [true, true],
      [true, false],
    ]);
    expect(v[0]!.collapsed).toBe(true);
    expect(v[0]!.label).toBe('app（x）');
    expect(v[1]!.label).toBe('app（y）');
  });

  it('未运行的成员用会话存储里的标题，显示为不可用；开始运行后自动变为可用', async () => {
    const c = setup();
    c.store.add({ hostSessionId: h('a'), title: '会话存储里的标题', cwd: '/w/app', cliSessionId: 'cli-a' });
    const d = [c.dir('/w/app', 'a')];
    await c.refresh(d);
    let r = c.view(d)[0]!.rows[0]!;
    expect(r).toMatchObject({ name: '会话存储里的标题', mode: 'unavailable', available: false, status: undefined, shortId: 'a' });
    c.reg.add({ sessionId: 'cli-a', pid: 1, hostSessionId: h('a'), name: '新名字', cwd: '/w/app' });
    await c.catalog.tick();
    r = c.view(d)[0]!.rows[0]!;
    expect(r).toMatchObject({ name: '新名字', mode: 'off', available: true, status: 'idle' });
  });

  it('会话号取桌面版会话 id 去掉 local_ 前缀后的前 8 位', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'cli', pid: 1, hostSessionId: 'local_054fbaf1-430e-492d-8a02', name: undefined });
    const d: DirSetting[] = [{ path: '/work/proj', collapsed: false, members: ['local_054fbaf1-430e-492d-8a02'] }];
    await c.refresh(d);
    expect(c.view(d)[0]!.rows[0]).toMatchObject({ shortId: '054fbaf1', name: '054fbaf1' });
  });
});

describe('Catalog 刷新时移出成员', () => {
  it('已归档的、既不在存储也没在运行的成员被移出；其余保留', async () => {
    const c = setup();
    c.store.add({ hostSessionId: h('keep'), cwd: '/work/proj' });
    c.store.add({ hostSessionId: h('arch'), cwd: '/work/proj', archived: true });
    c.reg.add({ sessionId: 'run', pid: 1 });
    const d = [c.dir('/work/proj', 'keep', 'arch', 'deleted', 'run')];
    const { gone } = await c.refresh(d);
    expect(gone.sort()).toEqual([h('arch'), h('deleted')]);
  });

  it('会话存储读不到时不移出任何成员', async () => {
    const c = setup();
    c.store.unreadable = true;
    const d = [c.dir('/work/proj', 'x', 'y')];
    expect((await c.refresh(d)).gone).toEqual([]);
  });
});

describe('Catalog 添加会话候选', () => {
  it('归属该工作区、未归档、未被任何工作区添加，按更新时间倒序，含未运行的', async () => {
    const c = setup();
    c.store.add({ hostSessionId: h('old'), title: '旧', cwd: '/w/app', lastActivityAt: T0 - 5000 });
    c.store.add({ hostSessionId: h('new'), title: '新', cwd: '/w/app/.claude/worktrees/x', lastActivityAt: T0 - 1000 });
    c.store.add({ hostSessionId: h('arch'), cwd: '/w/app', archived: true });
    c.store.add({ hostSessionId: h('taken'), cwd: '/w/app' });
    c.store.add({ hostSessionId: h('other'), cwd: '/elsewhere' });
    c.store.add({ hostSessionId: h('inner'), cwd: '/w/app/sub', lastActivityAt: T0 });
    const d = [c.dir('/w/app'), c.dir('/w/app/sub'), c.dir('/z', 'taken')];
    const r = await c.catalog.candidates('/w/app', d);
    expect(r.degraded).toBe(false);
    expect(r.items.map((i) => i.title)).toEqual(['新', '旧']); // inner 归更深的 /w/app/sub；taken 已被添加
    expect(r.items[0]).toMatchObject({ id: h('new'), shortId: 'new' });
  });

  it('会话存储读不到：降级为只列运行中的会话', async () => {
    const c = setup();
    c.store.unreadable = true;
    c.reg.add({ sessionId: 'a', pid: 1, cwd: '/w/app', name: '运行中' });
    const r = await c.catalog.candidates('/w/app', [c.dir('/w/app')]);
    expect(r).toMatchObject({ degraded: true });
    expect(r.items.map((i) => i.title)).toEqual(['运行中']);
  });

  it('运行中但存储里没有的会话也能被列出；存储标为归档的不列', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1, cwd: '/w/app', name: 'A' });
    c.reg.add({ sessionId: 'b', pid: 2, cwd: '/w/app', name: 'B' });
    c.store.add({ hostSessionId: h('b'), cwd: '/w/app', archived: true });
    const r = await c.catalog.candidates('/w/app', [c.dir('/w/app')]);
    expect(r.items.map((i) => i.title)).toEqual(['A']);
  });
});

describe('Catalog 排序与刷新', () => {
  it('按最后请求时间从新到旧；监控中时间变化不重排，刷新后才重排', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'old', pid: 1 });
    c.reg.add({ sessionId: 'new', pid: 2 });
    c.tr.addUser('old', { timestamp: T0 - 100 * S });
    c.tr.addUser('new', { timestamp: T0 - 10 * S });
    const d = [c.dir('/work', 'old', 'new')];
    await c.refresh(d);
    expect(c.view(d)[0]!.rows.map((r) => r.id)).toEqual([h('new'), h('old')]);

    c.tr.addUser('old', { timestamp: T0 - 1 * S });
    await c.catalog.tick();
    expect(c.view(d)[0]!.rows[1]!.lastRequestAt).toBe(T0 - 100 * S); // 未勾选的会话不会自己更新
    await c.catalog.reloadLastRequests(c.dir('/work', 'old', 'new').members);
    expect(c.view(d)[0]!.rows[1]!.lastRequestAt).toBe(T0 - 1 * S);
    expect(c.view(d)[0]!.rows.map((r) => r.id)).toEqual([h('new'), h('old')]); // 顺序仍不变

    await c.refresh(d);
    expect(c.view(d)[0]!.rows.map((r) => r.id)).toEqual([h('old'), h('new')]);
  });

  it('向工作区添加会话只重排该工作区，不动其他工作区', async () => {
    const c = setup();
    for (const [id, ago] of [['a1', 50], ['a2', 40], ['b1', 50], ['b2', 40]] as const) {
      c.reg.add({ sessionId: id, pid: 1 + Number(id.slice(1)) + (id[0] === 'b' ? 10 : 0) });
      c.tr.addUser(id, { timestamp: T0 - ago * S });
    }
    const d = [c.dir('/work', 'a1'), c.dir('/work2', 'b1')];
    await c.refresh(d);
    c.view(d);
    d[0]!.members.push(h('a2'));
    d[1]!.members.push(h('b2'));
    await c.catalog.onMembersAdded('/work', [h('a2')]);
    const v = c.view(d);
    expect(v[0]!.rows.map((r) => r.id)).toEqual([h('a2'), h('a1')]); // 重排：新的在前
    expect(v[1]!.rows.map((r) => r.id)).toEqual([h('b1'), h('b2')]); // 没重排：新成员接在末尾
  });

  it('添加工作区请求整体重排', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1 });
    c.reg.add({ sessionId: 'b', pid: 2 });
    c.tr.addUser('a', { timestamp: T0 - 10 * S });
    c.tr.addUser('b', { timestamp: T0 - 20 * S });
    const d = [c.dir('/work', 'a', 'b')];
    await c.refresh(d);
    c.view(d);
    c.tr.addUser('b', { timestamp: T0 });
    await c.catalog.reloadLastRequests(d[0]!.members);
    expect(c.view(d)[0]!.rows.map((r) => r.id)).toEqual([h('a'), h('b')]);
    c.catalog.requestResort();
    expect(c.view(d)[0]!.rows.map((r) => r.id)).toEqual([h('b'), h('a')]);
  });

  it('会话退出后保留为不可用，名称仍在', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1, name: '我的会话' });
    const d = [c.dir('/work', 'a')];
    await c.refresh(d);
    c.reg.remove('a');
    await c.catalog.tick();
    const row = c.view(d)[0]!.rows[0]!;
    expect(row).toMatchObject({ available: false, mode: 'unavailable', name: '我的会话' });
  });
});

describe('Catalog 未勾选会话不实时读取记录', () => {
  it('tick 不读记录文件；刷新、取消勾选、每小时重读才读，且只读成员', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1 });
    c.reg.add({ sessionId: 'z', pid: 2 }); // 不是成员
    c.tr.addUser('a', { timestamp: T0 - 10 * S });
    let reads = 0;
    const orig = c.tr.peekLastRequest.bind(c.tr);
    c.tr.peekLastRequest = async (id) => {
      reads++;
      return orig(id);
    };
    const d = [c.dir('/work', 'a')];
    await c.refresh(d);
    expect(reads).toBe(1);
    for (let i = 0; i < 5; i++) await c.catalog.tick();
    expect(reads).toBe(1);

    c.tr.addUser('a', { timestamp: T0 - 2 * S });
    await c.catalog.reloadLastRequest(h('a'));
    expect(reads).toBe(2);
    expect(c.view(d)[0]!.rows[0]!.lastRequestAt).toBe(T0 - 2 * S);
    await c.catalog.reloadLastRequests([h('a')]);
    expect(reads).toBe(3);
  });

  it('记录文件读不到时退回注册文件的 statusUpdatedAt，没有注册文件时退回存储的 lastActivityAt', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1, statusUpdatedAt: T0 - 7 * S });
    c.tr.missing.add('a');
    c.store.add({ hostSessionId: h('b'), cliSessionId: 'b', cwd: '/work/proj', lastActivityAt: T0 - 9 * S });
    c.tr.missing.add('b');
    const d = [c.dir('/work', 'a', 'b')];
    await c.refresh(d);
    const rows = c.view(d)[0]!.rows;
    expect(rows.find((r) => r.id === h('a'))!.lastRequestAt).toBe(T0 - 7 * S);
    expect(rows.find((r) => r.id === h('b'))!.lastRequestAt).toBe(T0 - 9 * S);
  });
});

describe('Catalog 行视图', () => {
  it('未监控：状态、缓存余温', async () => {
    const c = setup();
    c.reg.add({ sessionId: '6e8d4425-1853-4e73', pid: 1, name: undefined, status: 'busy' });
    c.tr.addUser('6e8d4425-1853-4e73', { timestamp: T0 - 400 * S });
    const d = [c.dir('/work', '6e8d4425-1853-4e73')];
    await c.refresh(d);
    const r = c.view(d)[0]!.rows[0]!;
    expect(r.name).toBe('6e8d4425');
    expect(r.mode).toBe('off');
    expect(r.checked).toBe(false);
    expect(r.status).toBe('busy');
    expect(r.ageMs).toBe(400 * S);
    expect(r.coldMs).toBe(100 * S);
    expect(r.countdownMs).toBeNull();
  });

  it('监控中：倒计时、连续次数、上限；等待空闲标记；折叠摘要', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1 });
    c.reg.add({ sessionId: 'b', pid: 2, status: 'busy' });
    c.reg.add({ sessionId: 'c', pid: 3 });
    for (const id of ['a', 'b', 'c']) c.tr.addUser(id, { timestamp: T0 - 20 * S });
    const d = [c.dir('/work', 'a', 'b', 'c')];
    await c.refresh(d);
    await c.mon.check('a');
    await c.mon.check('b');
    const g = c.view(d)[0]!;
    const a = g.rows.find((r) => r.id === h('a'))!;
    const b = g.rows.find((r) => r.id === h('b'))!;
    expect(a).toMatchObject({ checked: true, mode: 'watching', countdownMs: 250 * S, streak: 0, cap: 26, waitingIdle: false });
    expect(b.waitingIdle).toBe(true);
    expect(g.summary).toEqual({ sessions: 3, monitoring: 2, expired: 0, failed: 0 });
  });

  it('待恢复的会话带 pendingRestore 标记', async () => {
    const c = setup();
    c.store.add({ hostSessionId: h('a'), cwd: '/work/proj' });
    const d = [c.dir('/work', 'a')];
    await c.refresh(d);
    expect(c.view(d, ['a'])[0]!.rows[0]!.pendingRestore).toBe(true);
    expect(c.view(d)[0]!.rows[0]!.pendingRestore).toBe(false);
  });

  it('忙碌中的监控：距上次请求达到 4:30 为 soon，超过 5 分钟为 expired，其余 none', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1, status: 'busy' });
    c.tr.addUser('a', { timestamp: T0 - 10 * S });
    const d = [c.dir('/work', 'a')];
    await c.refresh(d);
    await c.mon.check('a');
    const stall = () => c.view(d)[0]!.rows[0]!.stall;
    expect(stall()).toBe('none');
    c.clock.advance(260 * S);
    expect(stall()).toBe('soon');
    c.clock.advance(40 * S);
    expect(stall()).toBe('expired');
    c.reg.get('a').status = 'idle';
    await c.catalog.tick();
    expect(stall()).toBe('none');
  });

  it('已退出的监控显示提示且不算勾选', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1 });
    c.tr.addUser('a', { timestamp: T0 });
    const d = [c.dir('/work', 'a')];
    await c.refresh(d);
    await c.mon.check('a');
    c.reg.remove('a');
    await c.mon.tick();
    await c.catalog.tick();
    const r = c.view(d)[0]!.rows[0]!;
    expect(r).toMatchObject({ checked: false, mode: 'gone', available: false });
    expect(r.note).toContain('会话已退出');
  });
});
