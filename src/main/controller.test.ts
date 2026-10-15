import { beforeEach, describe, expect, it } from 'vitest';
import type { Settings } from '../core/settings';
import { FakeClock, FakeRegistry, FakeSender, FakeTranscripts, T0 } from '../core/testing/fakes';
import type { Notice } from '../core/types';
import type { UiState } from '../shared/ipc';
import { Controller } from './controller';

function setup(initial: Settings = { content: '1', intervalSec: 270, dirs: [] }) {
  const clock = new FakeClock();
  const reg = new FakeRegistry();
  const tr = new FakeTranscripts();
  const sender = new FakeSender(clock, tr);
  const saved: Settings[] = [];
  const pushes: UiState[] = [];
  const notices: Notice[] = [];
  const picks: (string | null)[] = [];
  const c = new Controller({
    clock,
    registry: reg,
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
  return { clock, reg, tr, sender, saved, pushes, notices, picks, c };
}

describe('Controller 目录管理', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => void (t = setup()));

  it('添加目录：加到末尾、不重复、取消不添加，并保存', async () => {
    t.picks.push('/w/a', '/w/b/', '/w/a', null);
    for (let i = 0; i < 4; i++) await t.c.addDir();
    expect(t.c.getState().groups.map((g) => g.path)).toEqual(['/w/a', '/w/b']);
    expect(t.saved.at(-1)!.dirs.map((d) => d.path)).toEqual(['/w/a', '/w/b']);
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
    expect(t.saved.at(-1)!.dirs).toEqual([
      { path: '/w/b', collapsed: false },
      { path: '/w/a', collapsed: true },
      { path: '/w/c', collapsed: false },
    ]);
  });

  it('移除目录：其下会话立即停止监控，其他目录的不受影响', async () => {
    t.reg.add({ sessionId: 'a', pid: 1, cwd: '/w/a/x' });
    t.reg.add({ sessionId: 'b', pid: 2, cwd: '/w/b' });
    t.tr.addUser('a', { timestamp: T0 });
    t.tr.addUser('b', { timestamp: T0 });
    t.picks.push('/w/a', '/w/b');
    await t.c.addDir();
    await t.c.addDir();
    await t.c.setChecked('a', true);
    await t.c.setChecked('b', true);
    t.c.removeDir('/w/a');
    expect(t.c.monitor.get('a')).toBeUndefined();
    expect(t.c.monitor.get('b')?.mode).toBe('watching');
    expect(t.c.getState().groups.map((g) => g.path)).toEqual(['/w/b']);
  });

  it('添加目录不会自动勾选其下会话', async () => {
    t.reg.add({ sessionId: 'a', pid: 1, cwd: '/w/a' });
    t.picks.push('/w/a');
    await t.c.addDir();
    expect(t.c.monitor.states()).toHaveLength(0);
    expect(t.c.getState().groups[0]!.rows[0]!.mode).toBe('off');
  });
});

describe('Controller 设置', () => {
  it('发送内容：空白不接受，合法值保存', () => {
    const t = setup();
    expect(t.c.setContent('  ')).toMatch(/不能为空/);
    expect(t.c.setContent(' ping ')).toBeNull();
    expect(t.c.getState().content).toBe('ping');
    expect(t.saved.at(-1)!.content).toBe('ping');
  });

  it('空闲间隔：超出 1:00 到 4:50 或格式不对不允许保存', () => {
    const t = setup();
    for (const bad of ['0:59', '4:51', '5:00', 'x', '']) expect(t.c.setIntervalText(bad)).toMatch(/1:00 到 4:50/);
    expect(t.saved).toHaveLength(0);
    expect(t.c.setIntervalText('2:00')).toBeNull();
    expect(t.c.getState().intervalSec).toBe(120);
    expect(t.saved.at(-1)!.intervalSec).toBe(120);
  });

  it('修改间隔后正在监控的会话按新间隔重新计算', async () => {
    const t = setup({ content: '1', intervalSec: 270, dirs: [{ path: '/work', collapsed: false }] });
    t.reg.add({ sessionId: 'a', pid: 1 });
    t.tr.addUser('a', { timestamp: T0 - 20_000 });
    await t.c.start();
    await t.c.setChecked('a', true);
    expect(t.c.getState().groups[0]!.rows[0]).toMatchObject({ countdownMs: 250_000, cap: 26 });
    t.c.setIntervalText('1:00');
    expect(t.c.getState().groups[0]!.rows[0]).toMatchObject({ countdownMs: 40_000, cap: 120 });
    t.c.stop();
  });

  it('勾选状态不写入设置', async () => {
    const t = setup({ content: '1', intervalSec: 270, dirs: [{ path: '/work', collapsed: false }] });
    t.reg.add({ sessionId: 'a', pid: 1 });
    t.tr.addUser('a', { timestamp: T0 });
    await t.c.start();
    await t.c.setChecked('a', true);
    t.c.setContent('x');
    expect(JSON.stringify(t.saved.at(-1))).not.toContain('"a"');
    t.c.stop();
  });
});

describe('Controller 最后请求时间', () => {
  it('取消勾选时更新一次，之后不再自己变化；勾选的会话实时变化', async () => {
    const t = setup({ content: '1', intervalSec: 270, dirs: [{ path: '/work', collapsed: false }] });
    t.reg.add({ sessionId: 'a', pid: 1 });
    t.tr.addUser('a', { timestamp: T0 - 100_000 });
    await t.c.start();
    const last = () => t.c.getState().groups[0]!.rows[0]!.lastRequestAt;
    expect(last()).toBe(T0 - 100_000);

    t.tr.addUser('a', { timestamp: T0 - 50_000, originKind: 'human' });
    await t.c.tick();
    expect(last()).toBe(T0 - 100_000); // 未勾选：不跟踪

    await t.c.setChecked('a', true);
    expect(last()).toBe(T0 - 50_000); // 勾选时以最新记录为基线
    t.tr.addUser('a', { timestamp: T0 - 20_000, originKind: 'human' });
    await t.c.tick();
    expect(last()).toBe(T0 - 20_000); // 勾选中：实时

    t.tr.addUser('a', { timestamp: T0 - 5_000, originKind: 'human' });
    await t.c.setChecked('a', false);
    expect(last()).toBe(T0 - 5_000); // 取消勾选时更新一次
    t.tr.addUser('a', { timestamp: T0 - 1_000, originKind: 'human' });
    await t.c.tick();
    expect(last()).toBe(T0 - 5_000);
    t.c.stop();
  });
});

describe('Controller 刷新与推送', () => {
  it('手动刷新：新会话出现，“会话已退出”提示消失', async () => {
    const t = setup({ content: '1', intervalSec: 270, dirs: [{ path: '/work', collapsed: false }] });
    t.reg.add({ sessionId: 'a', pid: 1 });
    t.tr.addUser('a', { timestamp: T0 });
    await t.c.start();
    await t.c.setChecked('a', true);
    t.reg.remove('a');
    t.reg.add({ sessionId: 'b', pid: 2 });
    await t.c.tick();
    let rows = t.c.getState().groups[0]!.rows;
    expect(rows.map((r) => [r.sessionId, r.mode])).toEqual([['a', 'gone']]);
    await t.c.refresh();
    rows = t.c.getState().groups[0]!.rows;
    expect(rows.map((r) => [r.sessionId, r.mode])).toEqual([['b', 'off']]);
    t.c.stop();
  });

  it('状态变化会推送给界面', async () => {
    const t = setup({ content: '1', intervalSec: 270, dirs: [{ path: '/work', collapsed: false }] });
    t.reg.add({ sessionId: 'a', pid: 1 });
    t.tr.addUser('a', { timestamp: T0 });
    await t.c.start();
    const n = t.pushes.length;
    await t.c.setChecked('a', true);
    expect(t.pushes.length).toBeGreaterThan(n);
    expect(t.pushes.at(-1)!.groups[0]!.rows[0]!.mode).toBe('watching');
    t.c.stop();
  });
});
