import { describe, expect, it } from 'vitest';
import { Catalog } from './catalog';
import { Monitor } from './monitor';
import { FakeClock, FakeRegistry, FakeSender, FakeTranscripts, T0 } from './testing/fakes';
import type { DirSetting } from './settings';

const S = 1000;

function setup() {
  const clock = new FakeClock();
  const reg = new FakeRegistry();
  const tr = new FakeTranscripts();
  const sender = new FakeSender(clock, tr);
  const catalog = new Catalog({ registry: reg, probe: reg, transcripts: tr, clock });
  const mon = new Monitor({
    clock,
    registry: reg,
    probe: reg,
    transcripts: tr,
    sender,
    getSettings: () => ({ content: '1', intervalSec: 270 }),
    notify: () => undefined,
  });
  const dirs = (...paths: string[]): DirSetting[] => paths.map((path) => ({ path, collapsed: false }));
  const view = (d: DirSetting[]) => catalog.view(d, new Map(mon.states().map((s) => [s.sessionId, s])), 270);
  return { clock, reg, tr, catalog, mon, dirs, view };
}

describe('Catalog 成员与分组', () => {
  it('只显示已添加目录（含子目录）下的桌面版会话，嵌套时归最深目录', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1, cwd: '/w/app' });
    c.reg.add({ sessionId: 'b', pid: 2, cwd: '/w/app/.claude/worktrees/ui' });
    c.reg.add({ sessionId: 'c', pid: 3, cwd: '/w/app/sub' });
    c.reg.add({ sessionId: 'd', pid: 4, cwd: '/elsewhere' });
    c.reg.add({ sessionId: 'e', pid: 5, cwd: '/w/app', entrypoint: 'cli' });
    await c.catalog.refresh();
    const v = c.view(c.dirs('/w', '/w/app/sub'));
    expect(v[0]!.rows.map((r) => r.sessionId).sort()).toEqual(['a', 'b']);
    expect(v[1]!.rows.map((r) => r.sessionId)).toEqual(['c']);
    expect(v[1]!.rows[0]!.subPath).toBe('');
    expect(v[0]!.rows.find((r) => r.sessionId === 'b')!.subPath).toBe('app/.claude/worktrees/ui');
  });

  it('目录下没有会话时分组仍存在，行为空', async () => {
    const c = setup();
    await c.catalog.refresh();
    const v = c.view(c.dirs('/empty'));
    expect(v).toHaveLength(1);
    expect(v[0]!.rows).toEqual([]);
    expect(v[0]!.label).toBe('empty');
  });

  it('上移下移按钮的可用性、折叠状态、同名标题', async () => {
    const c = setup();
    await c.catalog.refresh();
    const d = [
      { path: '/x/app', collapsed: true },
      { path: '/y/app', collapsed: false },
      { path: '/z', collapsed: false },
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
});

describe('Catalog 排序与刷新', () => {
  it('按最后请求时间从新到旧；监控中时间变化不重排，刷新后才重排', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'old', pid: 1 });
    c.reg.add({ sessionId: 'new', pid: 2 });
    c.tr.addUser('old', { timestamp: T0 - 100 * S });
    c.tr.addUser('new', { timestamp: T0 - 10 * S });
    await c.catalog.refresh();
    const d = c.dirs('/work');
    expect(c.view(d)[0]!.rows.map((r) => r.sessionId)).toEqual(['new', 'old']);

    c.tr.addUser('old', { timestamp: T0 - 1 * S });
    await c.catalog.tick();
    expect(c.view(d)[0]!.rows[1]!.lastRequestAt).toBe(T0 - 100 * S); // 未勾选的会话不会自己更新
    await c.catalog.reloadLastRequests(['/work']);
    expect(c.view(d)[0]!.rows[1]!.lastRequestAt).toBe(T0 - 1 * S);
    expect(c.view(d)[0]!.rows.map((r) => r.sessionId)).toEqual(['new', 'old']); // 顺序仍不变

    await c.catalog.refresh();
    expect(c.view(d)[0]!.rows.map((r) => r.sessionId)).toEqual(['old', 'new']);
  });

  it('新开的会话刷新后才出现', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1 });
    await c.catalog.refresh();
    c.reg.add({ sessionId: 'b', pid: 2 });
    await c.catalog.tick();
    expect(c.view(c.dirs('/work'))[0]!.rows.map((r) => r.sessionId)).toEqual(['a']);
    await c.catalog.refresh();
    expect(c.view(c.dirs('/work'))[0]!.rows.map((r) => r.sessionId).sort()).toEqual(['a', 'b']);
  });

  it('会话退出后保留为不可用，刷新后消失', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1 });
    await c.catalog.refresh();
    c.reg.remove('a');
    await c.catalog.tick();
    const row = c.view(c.dirs('/work'))[0]!.rows[0]!;
    expect(row.available).toBe(false);
    expect(row.mode).toBe('unavailable');
    await c.catalog.refresh();
    expect(c.view(c.dirs('/work'))[0]!.rows).toHaveLength(0);
  });

  it('添加目录请求重排', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1 });
    c.reg.add({ sessionId: 'b', pid: 2 });
    c.tr.addUser('a', { timestamp: T0 - 10 * S });
    c.tr.addUser('b', { timestamp: T0 - 20 * S });
    await c.catalog.refresh();
    c.view(c.dirs('/work'));
    c.tr.addUser('b', { timestamp: T0 });
    await c.catalog.reloadLastRequests(['/work']);
    expect(c.view(c.dirs('/work'))[0]!.rows.map((r) => r.sessionId)).toEqual(['a', 'b']);
    c.catalog.requestResort();
    expect(c.view(c.dirs('/work'))[0]!.rows.map((r) => r.sessionId)).toEqual(['b', 'a']);
  });
});

describe('Catalog 未勾选会话不实时读取记录', () => {
  it('tick 不读记录文件；刷新、取消勾选、每小时重读才读', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1 });
    c.tr.addUser('a', { timestamp: T0 - 10 * S });
    let reads = 0;
    const orig = c.tr.peekLast.bind(c.tr);
    c.tr.peekLast = async (id) => {
      reads++;
      return orig(id);
    };
    await c.catalog.refresh();
    expect(reads).toBe(1);
    for (let i = 0; i < 5; i++) await c.catalog.tick();
    expect(reads).toBe(1);

    c.tr.addUser('a', { timestamp: T0 - 2 * S });
    await c.catalog.reloadLastRequest('a');
    expect(reads).toBe(2);
    expect(c.view(c.dirs('/work'))[0]!.rows[0]!.lastRequestAt).toBe(T0 - 2 * S);
    await c.catalog.reloadLastRequests(['/work']);
    expect(reads).toBe(3);
    await c.catalog.reloadLastRequests(['/other']); // 目录之外的会话不读取
    expect(reads).toBe(3);
  });
});

describe('Catalog 行视图', () => {
  it('未监控：状态、会话号前 8 位、缓存余温', async () => {
    const c = setup();
    c.reg.add({ sessionId: '6e8d4425-1853-4e73', pid: 1, name: undefined, status: 'busy' });
    c.tr.addUser('6e8d4425-1853-4e73', { timestamp: T0 - 400 * S });
    await c.catalog.refresh();
    const r = c.view(c.dirs('/work'))[0]!.rows[0]!;
    expect(r.name).toBe('6e8d4425');
    expect(r.shortId).toBe('6e8d4425');
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
    c.tr.addUser('a', { timestamp: T0 - 20 * S });
    c.tr.addUser('b', { timestamp: T0 - 20 * S });
    c.tr.addUser('c', { timestamp: T0 - 20 * S });
    await c.catalog.refresh();
    await c.mon.check('a');
    await c.mon.check('b');
    const g = c.view(c.dirs('/work'))[0]!;
    const a = g.rows.find((r) => r.sessionId === 'a')!;
    const b = g.rows.find((r) => r.sessionId === 'b')!;
    expect(a).toMatchObject({ checked: true, mode: 'watching', countdownMs: 250 * S, streak: 0, cap: 26, waitingIdle: false });
    expect(b.waitingIdle).toBe(true);
    expect(g.summary).toEqual({ sessions: 3, monitoring: 2, expired: 0, failed: 0 });
  });

  it('忙碌中的监控：距上次请求达到 4:30 为 soon，超过 5 分钟为 expired，其余 none', async () => {
    const c = setup();
    c.reg.add({ sessionId: 'a', pid: 1, status: 'busy' });
    c.tr.addUser('a', { timestamp: T0 - 10 * S });
    await c.catalog.refresh();
    await c.mon.check('a');
    const stall = () => c.view(c.dirs('/work'))[0]!.rows[0]!.stall;
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
    await c.catalog.refresh();
    await c.mon.check('a');
    c.reg.remove('a');
    await c.mon.tick();
    await c.catalog.tick();
    const r = c.view(c.dirs('/work'))[0]!.rows[0]!;
    expect(r).toMatchObject({ checked: false, mode: 'gone', available: false });
    expect(r.note).toContain('会话已退出');
  });
});
