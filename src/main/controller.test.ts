import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings, type DirSetting, type Settings } from '../core/settings';
import { FakeClock, FakeRegistry, FakeSender, FakeStore, FakeTranscripts, T0 } from '../core/testing/fakes';
import type { Notice } from '../core/types';
import type { UiState } from '../shared/ipc';
import { Controller } from './controller';

const h = (id: string) => `local_${id}`;
const dir = (path: string, members: string[] = [], collapsed = false): DirSetting => ({ path, collapsed, members: members.map(h) });
const settings = (over: Partial<Settings> = {}): Settings => ({ ...defaultSettings(), content: '1', ...over });

function setup(initial: Settings = settings()) {
  const clock = new FakeClock();
  const reg = new FakeRegistry();
  const store = new FakeStore();
  const tr = new FakeTranscripts();
  const sender = new FakeSender(clock, tr);
  const saved: Settings[] = [];
  const pushes: UiState[] = [];
  const notices: Notice[] = [];
  const picks: (string | null)[] = [];
  const c = new Controller({
    clock,
    registry: reg,
    store,
    probe: reg,
    transcripts: tr,
    sender,
    loadSettings: () => structuredClone(initial),
    saveSettings: (s) => void saved.push(structuredClone(s)),
    notify: (n) => void notices.push(n),
    pickDirectory: async () => picks.shift() ?? null,
    push: (s) => void pushes.push(s),
    getPeerError: () => null,
  });
  const rows = (i = 0) => c.getState().groups[i]!.rows;
  const last = () => saved.at(-1)!;
  return { clock, reg, store, tr, sender, saved, pushes, notices, picks, c, rows, last };
}

describe('Controller 工作区管理', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => void (t = setup()));

  it('添加工作区：加到末尾、不重复、取消不添加，默认为空，并保存', async () => {
    t.reg.add({ sessionId: 'a', pid: 1, cwd: '/w/a' });
    t.picks.push('/w/a', '/w/b/', '/w/a', null);
    for (let i = 0; i < 4; i++) await t.c.addDir();
    expect(t.c.getState().groups.map((g) => g.path)).toEqual(['/w/a', '/w/b']);
    expect(t.c.getState().groups[0]!.rows).toEqual([]); // 目录里有运行中的会话，也不自动纳入
    expect(t.last().dirs).toEqual([
      { path: '/w/a', collapsed: false, members: [] },
      { path: '/w/b', collapsed: false, members: [] },
    ]);
  });

  it('上移下移与折叠，首个不能上移、末个不能下移', async () => {
    t.picks.push('/w/a', '/w/b', '/w/c');
    for (let i = 0; i < 3; i++) await t.c.addDir();
    t.c.moveDir('/w/a', -1);
    t.c.moveDir('/w/c', 1);
    expect(t.c.getState().groups.map((g) => g.path)).toEqual(['/w/a', '/w/b', '/w/c']);
    t.c.moveDir('/w/b', -1);
    expect(t.c.getState().groups.map((g) => g.path)).toEqual(['/w/b', '/w/a', '/w/c']);
    t.c.setCollapsed('/w/a', true);
    expect(t.last().dirs).toEqual([
      { path: '/w/b', collapsed: false, members: [] },
      { path: '/w/a', collapsed: true, members: [] },
      { path: '/w/c', collapsed: false, members: [] },
    ]);
  });

  it('移除工作区：其下会话立即停止监控、成员关系删除，其他工作区的不受影响', async () => {
    t = setup(settings({ dirs: [dir('/w/a', ['a']), dir('/w/b', ['b'])] }));
    t.reg.add({ sessionId: 'a', pid: 1, cwd: '/w/a' });
    t.reg.add({ sessionId: 'b', pid: 2, cwd: '/w/b' });
    t.tr.addUser('a', { timestamp: T0 });
    t.tr.addUser('b', { timestamp: T0 });
    await t.c.start();
    await t.c.setChecked(h('a'), true);
    await t.c.setChecked(h('b'), true);
    t.c.removeDir('/w/a');
    expect(t.c.monitor.get('a')).toBeUndefined();
    expect(t.c.monitor.get('b')?.mode).toBe('watching');
    expect(t.c.getState().groups.map((g) => g.path)).toEqual(['/w/b']);
    expect(t.last().checked).toEqual([h('b')]);
    t.c.stop();
  });
});

describe('Controller 添加与移除会话', () => {
  it('候选里的会话可以添加；已被添加的、不属于该工作区的、已归档的不在候选里，也不会被添加', async () => {
    const t = setup(settings({ dirs: [dir('/w/a', ['taken']), dir('/w/b')] }));
    t.store.add({ hostSessionId: h('taken'), cwd: '/w/a' });
    t.store.add({ hostSessionId: h('s1'), title: '会话一', cwd: '/w/a', lastActivityAt: T0 - 1000 });
    t.store.add({ hostSessionId: h('s2'), title: '会话二', cwd: '/w/a/sub', lastActivityAt: T0 - 500 });
    t.store.add({ hostSessionId: h('arch'), cwd: '/w/a', archived: true });
    t.store.add({ hostSessionId: h('far'), cwd: '/w/b' });
    await t.c.start();
    const cands = await t.c.listCandidates('/w/a');
    expect(cands.items.map((i) => i.title)).toEqual(['会话二', '会话一']);

    await t.c.addSessions('/w/a', [h('s1'), h('arch'), h('far'), h('taken'), h('nope'), h('s1')]);
    expect(t.last().dirs[0]!.members).toEqual([h('taken'), h('s1')]);
    expect(t.rows().map((r) => [r.id, r.mode])).toContainEqual([h('s1'), 'unavailable']); // 未运行：不可用
    expect((await t.c.listCandidates('/w/a')).items.map((i) => i.title)).toEqual(['会话二']);
    t.c.stop();
  });

  it('添加后的会话不会自动勾选；运行中的可以勾选', async () => {
    const t = setup(settings({ dirs: [dir('/w/a')] }));
    t.reg.add({ sessionId: 'a', pid: 1, cwd: '/w/a' });
    t.tr.addUser('a', { timestamp: T0 });
    await t.c.start();
    await t.c.addSessions('/w/a', [h('a')]);
    expect(t.c.monitor.states()).toHaveLength(0);
    expect(t.rows()[0]!.mode).toBe('off');
    await t.c.setChecked(h('a'), true);
    expect(t.rows()[0]!.mode).toBe('watching');
    t.c.stop();
  });

  it('移除会话：停止监控、从成员和记住的勾选里去掉，不动其他成员', async () => {
    const t = setup(settings({ dirs: [dir('/w/a', ['a', 'b'])] }));
    for (const [id, pid] of [['a', 1], ['b', 2]] as const) {
      t.reg.add({ sessionId: id, pid, cwd: '/w/a' });
      t.tr.addUser(id, { timestamp: T0 });
    }
    await t.c.start();
    await t.c.setChecked(h('a'), true);
    await t.c.setChecked(h('b'), true);
    t.c.removeSession('/w/a', h('a'));
    expect(t.c.monitor.get('a')).toBeUndefined();
    expect(t.last().dirs[0]!.members).toEqual([h('b')]);
    expect(t.last().checked).toEqual([h('b')]);
    t.c.removeSession('/w/a', h('zzz')); // 不是成员：忽略
    expect(t.rows().map((r) => r.id)).toEqual([h('b')]);
    t.c.stop();
  });
});

describe('Controller 设置', () => {
  it('发送内容：空白不接受，合法值保存', () => {
    const t = setup();
    expect(t.c.setContent('  ')).toMatch(/不能为空/);
    expect(t.c.setContent(' ping ')).toBeNull();
    expect(t.c.getState().content).toBe('ping');
    expect(t.last().content).toBe('ping');
  });

  it('空闲间隔：超出 1:00 到 4:50 或格式不对不允许保存', () => {
    const t = setup();
    for (const bad of ['0:59', '4:51', '5:00', 'x', '']) expect(t.c.setIntervalText(bad)).toMatch(/1:00 到 4:50/);
    expect(t.saved).toHaveLength(0);
    expect(t.c.setIntervalText('2:00')).toBeNull();
    expect(t.c.getState().intervalSec).toBe(120);
    expect(t.last().intervalSec).toBe(120);
  });

  it('修改间隔后正在监控的会话按新间隔重新计算', async () => {
    const t = setup(settings({ dirs: [dir('/work', ['a'])] }));
    t.reg.add({ sessionId: 'a', pid: 1 });
    t.tr.addUser('a', { timestamp: T0 - 20_000 });
    await t.c.start();
    await t.c.setChecked(h('a'), true);
    expect(t.rows()[0]).toMatchObject({ countdownMs: 250_000, cap: 26 });
    t.c.setIntervalText('1:00');
    expect(t.rows()[0]).toMatchObject({ countdownMs: 40_000, cap: 120 });
    t.c.stop();
  });
});

describe('Controller 迁移（需求 5.7）', () => {
  it('从 v1.3 升级：每个旧目录里匹配到的运行中会话成为成员（含子目录、嵌套取最深），设置原样保留，只做一次', async () => {
    const old = settings({
      schemaVersion: 1,
      content: '自定义内容',
      intervalSec: 200,
      dirs: [dir('/w', [], true), dir('/w/app'), dir('/empty')],
    });
    const t = setup(old);
    t.reg.add({ sessionId: 'a', pid: 1, cwd: '/w/app' });
    t.reg.add({ sessionId: 'b', pid: 2, cwd: '/w/app/.claude/worktrees/x' });
    t.reg.add({ sessionId: 'c', pid: 3, cwd: '/w/other' });
    t.reg.add({ sessionId: 'd', pid: 4, cwd: '/nowhere' });
    t.reg.add({ sessionId: 'e', pid: 5, cwd: '/w/app', entrypoint: 'cli' });
    t.store.add({ hostSessionId: h('closed'), cwd: '/w/app' }); // 没在运行：旧版本本来就不显示，不迁移
    await t.c.start();
    expect(t.last()).toMatchObject({
      schemaVersion: 2,
      content: '自定义内容',
      intervalSec: 200,
      dirs: [
        { path: '/w', collapsed: true, members: [h('c')] },
        { path: '/w/app', collapsed: false, members: [h('a'), h('b')] },
        { path: '/empty', collapsed: false, members: [] },
      ],
    });
    t.c.stop();

    // 迁移过的设置再启动：成员完全由用户管理，不再自动补
    const again = setup(structuredClone(t.last()));
    again.reg.add({ sessionId: 'a', pid: 1, cwd: '/w/app' });
    again.reg.add({ sessionId: 'b', pid: 2, cwd: '/w/app/.claude/worktrees/x' });
    again.reg.add({ sessionId: 'f', pid: 9, cwd: '/w/app' });
    await again.c.start();
    expect(again.c.getState().groups[1]!.rows.map((r) => r.id).sort()).toEqual([h('a'), h('b')].sort());
    again.c.stop();
  });

  it('全新安装不需要迁移，也不会自动纳入任何会话', async () => {
    const t = setup(); // defaultSettings：schemaVersion 2
    t.reg.add({ sessionId: 'a', pid: 1, cwd: '/w/a' });
    await t.c.start();
    expect(t.saved).toHaveLength(0);
    t.c.stop();
  });
});

describe('Controller 勾选状态跨重启保留（需求 6.4）', () => {
  const two = () => setup(settings({ dirs: [dir('/work', ['a', 'b'])] }));

  it('勾选、取消勾选立即写入记住的集合', async () => {
    const t = two();
    for (const [id, pid] of [['a', 1], ['b', 2]] as const) {
      t.reg.add({ sessionId: id, pid });
      t.tr.addUser(id, { timestamp: T0 });
    }
    await t.c.start();
    await t.c.setChecked(h('a'), true);
    await t.c.setChecked(h('b'), true);
    expect(t.last().checked).toEqual([h('a'), h('b')]);
    await t.c.setChecked(h('a'), false);
    expect(t.last().checked).toEqual([h('b')]);
    t.c.stop();
  });

  it('只记监控中、发送中、已过期；已失败、已达上限的不记', async () => {
    const t = two();
    for (const [id, pid] of [['a', 1], ['b', 2]] as const) {
      t.reg.add({ sessionId: id, pid });
      t.tr.addUser(id, { timestamp: T0 });
    }
    t.sender.mode = 'none';
    await t.c.start();
    await t.c.setChecked(h('a'), true);
    await t.c.setChecked(h('b'), true);
    // a 的发送超时 → 失败
    t.clock.advance(270_000);
    await t.c.tick();
    t.clock.advance(31_000);
    await t.c.tick();
    expect(t.c.monitor.get('a')?.mode).toBe('failed');
    expect(t.last().checked).toEqual([]);
    t.c.stop();
  });

  it('重启后恢复：运行中的恢复勾选（次数从 0 开始）；缓存已过期的进入已过期，不自动发送', async () => {
    const t = setup(settings({ dirs: [dir('/work', ['a', 'b'])], checked: [h('a'), h('b')] }));
    t.reg.add({ sessionId: 'a', pid: 1 });
    t.reg.add({ sessionId: 'b', pid: 2 });
    t.tr.addUser('a', { timestamp: T0 - 20_000 });
    t.tr.addUser('b', { timestamp: T0 - 400_000 });
    await t.c.start();
    expect(t.c.monitor.get('a')).toMatchObject({ mode: 'watching', streak: 0 });
    expect(t.c.monitor.get('b')?.mode).toBe('expired');
    expect(t.sender.sent).toHaveLength(0);
    t.c.stop();
  });

  it('启动时没在运行的：留作待恢复，第一次变为可用时自动恢复一次，用户取消后不再恢复', async () => {
    const t = setup(settings({ dirs: [dir('/work', ['a'])], checked: [h('a')] }));
    t.store.add({ hostSessionId: h('a'), cliSessionId: 'a', cwd: '/work' });
    await t.c.start();
    expect(t.rows()[0]).toMatchObject({ pendingRestore: true, mode: 'unavailable' });
    expect(t.last).toBeDefined();
    t.reg.add({ sessionId: 'a', pid: 1 });
    t.tr.addUser('a', { timestamp: T0 - 10_000 });
    await t.c.tick();
    expect(t.rows()[0]).toMatchObject({ pendingRestore: false, mode: 'watching' });

    await t.c.setChecked(h('a'), false);
    await t.c.tick();
    expect(t.c.monitor.get('a')).toBeUndefined();
    t.c.stop();
  });

  it('待恢复期间退出程序，记住的集合仍保留', async () => {
    const t = setup(settings({ dirs: [dir('/work', ['a'])], checked: [h('a')] }));
    t.store.add({ hostSessionId: h('a'), cliSessionId: 'a', cwd: '/work' });
    await t.c.start();
    t.c.setContent('x'); // 任何一次保存都不能丢掉待恢复的勾选
    expect(t.last().checked).toEqual([h('a')]);
    t.c.stop();
  });

  it('退出（stop）不会清空记住的集合', async () => {
    const t = setup(settings({ dirs: [dir('/work', ['a'])] }));
    t.reg.add({ sessionId: 'a', pid: 1 });
    t.tr.addUser('a', { timestamp: T0 });
    await t.c.start();
    await t.c.setChecked(h('a'), true);
    const n = t.saved.length;
    t.c.stop(); // monitor.stopAll 会触发推送
    await Promise.resolve();
    expect(t.saved.slice(n)).toEqual([]);
    expect(t.last().checked).toEqual([h('a')]);
  });

  it('运行期间会话退出：自动取消勾选并从记住的集合里去掉，重新打开后不会自动恢复', async () => {
    const t = setup(settings({ dirs: [dir('/work', ['a'])] }));
    t.reg.add({ sessionId: 'a', pid: 1 });
    t.tr.addUser('a', { timestamp: T0 });
    await t.c.start();
    await t.c.setChecked(h('a'), true);
    t.reg.remove('a');
    await t.c.tick();
    expect(t.rows()[0]!.mode).toBe('gone');
    expect(t.last().checked).toEqual([]);
    t.reg.add({ sessionId: 'a', pid: 2 });
    await t.c.tick();
    expect(t.rows()[0]!.mode).not.toBe('watching');
    t.c.stop();
  });

  it('记住的会话已不是成员（被移除）时不恢复', async () => {
    const t = setup(settings({ dirs: [dir('/work', [])], checked: [h('a')] }));
    t.reg.add({ sessionId: 'a', pid: 1 });
    await t.c.start();
    expect(t.c.monitor.states()).toHaveLength(0);
    t.c.stop();
  });
});

describe('Controller 刷新与归档', () => {
  it('手动刷新：已归档、已删除的成员被移出并停止监控，“会话已退出”提示消失', async () => {
    const t = setup(settings({ dirs: [dir('/work', ['a', 'gone', 'del'])] }));
    t.reg.add({ sessionId: 'a', pid: 1 });
    t.reg.add({ sessionId: 'gone', pid: 2 });
    t.tr.addUser('a', { timestamp: T0 });
    t.tr.addUser('gone', { timestamp: T0 });
    t.store.add({ hostSessionId: h('a'), cwd: '/work' });
    t.store.add({ hostSessionId: h('gone'), cwd: '/work' });
    t.store.add({ hostSessionId: h('del'), cwd: '/work' });
    await t.c.start();
    await t.c.setChecked(h('gone'), true);
    t.store.sessions.find((s) => s.hostSessionId === h('gone'))!.archived = true;
    t.store.sessions = t.store.sessions.filter((s) => s.hostSessionId !== h('del'));
    t.reg.remove('gone');
    await t.c.refresh();
    expect(t.rows().map((r) => r.id)).toEqual([h('a')]);
    expect(t.last().dirs[0]!.members).toEqual([h('a')]);
    expect(t.last().checked).toEqual([]);
    expect(t.c.monitor.get('gone')).toBeUndefined();
    t.c.stop();
  });

  it('会话存储读不到时，刷新不移出任何成员', async () => {
    const t = setup(settings({ dirs: [dir('/work', ['a'])] }));
    t.store.unreadable = true;
    await t.c.start();
    await t.c.refresh();
    expect(t.rows().map((r) => r.id)).toEqual([h('a')]);
    t.c.stop();
  });

  it('状态变化会推送给界面', async () => {
    const t = setup(settings({ dirs: [dir('/work', ['a'])] }));
    t.reg.add({ sessionId: 'a', pid: 1 });
    t.tr.addUser('a', { timestamp: T0 });
    await t.c.start();
    const n = t.pushes.length;
    await t.c.setChecked(h('a'), true);
    expect(t.pushes.length).toBeGreaterThan(n);
    expect(t.pushes.at(-1)!.groups[0]!.rows[0]!.mode).toBe('watching');
    t.c.stop();
  });
});

describe('Controller 最后请求时间', () => {
  it('取消勾选时更新一次，之后不再自己变化；勾选的会话实时变化', async () => {
    const t = setup(settings({ dirs: [dir('/work', ['a'])] }));
    t.reg.add({ sessionId: 'a', pid: 1 });
    t.tr.addUser('a', { timestamp: T0 - 100_000 });
    await t.c.start();
    const last = () => t.rows()[0]!.lastRequestAt;
    expect(last()).toBe(T0 - 100_000);

    t.tr.addUser('a', { timestamp: T0 - 50_000, originKind: 'human' });
    await t.c.tick();
    expect(last()).toBe(T0 - 100_000); // 未勾选：不跟踪

    await t.c.setChecked(h('a'), true);
    expect(last()).toBe(T0 - 50_000); // 勾选时以最新记录为基线
    t.tr.addUser('a', { timestamp: T0 - 20_000, originKind: 'human' });
    await t.c.tick();
    expect(last()).toBe(T0 - 20_000); // 勾选中：实时

    t.tr.addUser('a', { timestamp: T0 - 5_000, originKind: 'human' });
    await t.c.setChecked(h('a'), false);
    expect(last()).toBe(T0 - 5_000); // 取消勾选时更新一次
    t.tr.addUser('a', { timestamp: T0 - 1_000, originKind: 'human' });
    await t.c.tick();
    expect(last()).toBe(T0 - 5_000);
    t.c.stop();
  });
});
