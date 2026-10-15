import { beforeEach, describe, expect, it } from 'vitest';
import { countdownMs, Monitor } from './monitor';
import { FakeClock, FakeRegistry, FakeSender, FakeTranscripts, T0 } from './testing/fakes';
import type { Notice } from './types';

const SID = '6e8d4425-1853-4e73-a4da-6cf45a68a024';
const S = 1000;
const MIN = 60 * S;

interface Ctx {
  clock: FakeClock;
  reg: FakeRegistry;
  tr: FakeTranscripts;
  sender: FakeSender;
  settings: { content: string; intervalSec: number };
  notices: Notice[];
  changes: number;
  mon: Monitor;
}

function setup(): Ctx {
  const clock = new FakeClock();
  const reg = new FakeRegistry();
  const tr = new FakeTranscripts();
  const sender = new FakeSender(clock, tr);
  const settings = { content: '1', intervalSec: 270 };
  const notices: Notice[] = [];
  const ctx = { clock, reg, tr, sender, settings, notices, changes: 0 } as Ctx;
  ctx.mon = new Monitor({
    clock,
    registry: reg,
    probe: reg,
    transcripts: tr,
    sender,
    getSettings: () => settings,
    notify: (n) => notices.push(n),
    onChange: () => void ctx.changes++,
  });
  return ctx;
}

/** 会话空闲，最后一次请求在 agoMs 之前，已勾选 */
async function watching(c: Ctx, agoMs = 10 * S, sid = SID, pid = 100): Promise<void> {
  c.reg.add({ sessionId: sid, pid, name: 'A' });
  c.tr.addUser(sid, { timestamp: c.clock.now() - agoMs });
  expect(await c.mon.check(sid)).toBe(true);
}

/** 推进时间并 tick 一次 */
async function step(c: Ctx, ms: number): Promise<void> {
  c.clock.advance(ms);
  await c.mon.tick();
}

describe('勾选', () => {
  let c: Ctx;
  beforeEach(() => void (c = setup()));

  it('以记录里最后一次请求（含工具返回后发出的请求）的时间为基线', async () => {
    c.reg.add({ sessionId: SID, pid: 100 });
    c.tr.addUser(SID, { timestamp: T0 - 100 * S });
    c.tr.addAssistant(SID, T0 - 99 * S);
    c.tr.addToolResult(SID, T0 - 20 * S);
    await c.mon.check(SID);
    const s = c.mon.get(SID)!;
    expect(s.mode).toBe('watching');
    expect(s.lastRequestAt).toBe(T0 - 20 * S);
    expect(countdownMs(s, 270, T0)).toBe(250 * S);
  });

  it('记录文件读不到时退回注册文件的 statusUpdatedAt', async () => {
    c.reg.add({ sessionId: SID, pid: 100, statusUpdatedAt: T0 - 40 * S });
    c.tr.missing.add(SID);
    await c.mon.check(SID);
    expect(c.mon.get(SID)!.lastRequestAt).toBe(T0 - 40 * S);
  });

  it('记录里还没有 user 记录同样退回 statusUpdatedAt', async () => {
    c.reg.add({ sessionId: SID, pid: 100, statusUpdatedAt: T0 - 5 * S });
    await c.mon.check(SID);
    expect(c.mon.get(SID)!.lastRequestAt).toBe(T0 - 5 * S);
  });

  it('不可用的会话不能勾选', async () => {
    c.reg.add({ sessionId: SID, pid: 100 });
    c.reg.deadPids.add(100);
    expect(await c.mon.check(SID)).toBe(false);
    expect(await c.mon.check('nope')).toBe(false);
    expect(c.mon.states()).toHaveLength(0);
  });

  it('勾选时距最后一次请求超过 5 分钟：已过期，不发送', async () => {
    await watching(c, 7 * MIN);
    expect(c.mon.get(SID)!.mode).toBe('expired');
    await step(c, 10 * MIN);
    expect(c.sender.sent).toHaveLength(0);
  });

  it('勾选时会话忙碌：不判断过期，等变为 idle 后再判断', async () => {
    c.reg.add({ sessionId: SID, pid: 100, status: 'busy' });
    c.tr.addUser(SID, { timestamp: T0 - 7 * MIN });
    await c.mon.check(SID);
    expect(c.mon.get(SID)!.mode).toBe('watching');
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('watching');
    c.reg.get(SID).status = 'idle';
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('expired');
    expect(c.sender.sent).toHaveLength(0);
  });

  it('取消勾选立即清空状态，再勾选次数归零', async () => {
    await watching(c, 270 * S);
    await step(c, 1 * S);
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.streak).toBe(1);
    c.mon.uncheck(SID);
    expect(c.mon.get(SID)).toBeUndefined();
    expect(c.mon.isChecked(SID)).toBe(false);
    await c.mon.check(SID);
    expect(c.mon.get(SID)!.streak).toBe(0);
    expect(c.mon.get(SID)!.lastResult).toBeNull();
  });
});

describe('到点发送', () => {
  let c: Ctx;
  beforeEach(() => void (c = setup()));

  it('倒计时没到不发送；到点发送设置里的内容，目标是注册文件里当前的套接字', async () => {
    c.settings.content = 'ping';
    await watching(c, 10 * S);
    await step(c, 200 * S);
    expect(c.sender.sent).toHaveLength(0);
    await step(c, 60 * S); // 距最后请求 270 秒
    expect(c.sender.sent).toHaveLength(1);
    expect(c.sender.sent[0]!.body).toBe('ping');
    expect(c.sender.sent[0]!.target).toEqual({ sessionId: SID, pid: 100, socketPath: '/tmp/cc-socks/100.sock' });
  });

  it('桌面版重启后 pid 和套接字都变了：按 sessionId 找到新项并用新套接字发送', async () => {
    await watching(c, 10 * S);
    const e = c.reg.get(SID);
    e.pid = 555;
    e.messagingSocketPath = '/tmp/cc-socks/555.sock';
    await step(c, 270 * S);
    expect(c.sender.sent[0]!.target.pid).toBe(555);
    expect(c.sender.sent[0]!.target.socketPath).toBe('/tmp/cc-socks/555.sock');
  });

  it('多个会话时只发给 sessionId 匹配的那个', async () => {
    c.reg.add({ sessionId: 'other', pid: 200 });
    c.tr.addUser('other', { timestamp: T0 });
    await watching(c, 10 * S);
    await step(c, 270 * S);
    expect(c.sender.sent).toHaveLength(1);
    expect(c.sender.sent[0]!.target.sessionId).toBe(SID);
    expect(c.sender.sent[0]!.target.socketPath).not.toContain('200');
  });

  it('记录里出现 origin.msg_id 等于本次 msgId 的 user 记录即成功，次数加一，倒计时重新起算', async () => {
    await watching(c, 10 * S);
    await step(c, 260 * S);
    expect(c.mon.get(SID)!.mode).toBe('sending');
    await step(c, 1 * S);
    const s = c.mon.get(SID)!;
    expect(s.mode).toBe('watching');
    expect(s.streak).toBe(1);
    expect(s.lastResult).toMatchObject({ ok: true });
    expect(countdownMs(s, 270, c.clock.now())).toBeGreaterThan(260 * S);
    expect(c.sender.sent).toHaveLength(1);
  });

  it('回执 delivered 也算成功', async () => {
    c.sender.mode = 'none';
    await watching(c, 270 * S);
    await step(c, 1 * S);
    c.mon.onReceipt({ origMsgId: 'msg-1', status: 'delivered' });
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.streak).toBe(1);
    expect(c.mon.get(SID)!.mode).toBe('watching');
  });

  it('发送判定完成前不会重复发送', async () => {
    c.sender.mode = 'none';
    await watching(c, 270 * S);
    for (let i = 0; i < 10; i++) await step(c, 1 * S);
    expect(c.sender.sent).toHaveLength(1);
    expect(c.mon.get(SID)!.mode).toBe('sending');
  });

  it('会话不是 idle（busy、waiting、shell）时到点不发送，变为 idle 后立即发送', async () => {
    await watching(c, 10 * S);
    for (const st of ['busy', 'waiting', 'shell'] as const) {
      c.reg.get(SID).status = st;
      await step(c, 100 * S);
      expect(c.sender.sent).toHaveLength(0);
    }
    expect(c.mon.get(SID)!.mode).toBe('watching'); // 忙碌期间不判断过期
    // 此时距最后请求 310 秒；忙碌结束后若无新记录则判为已过期
    c.reg.get(SID).status = 'idle';
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('expired');
  });

  it('忙碌结束时产生了新记录：按新时间起算，不发送', async () => {
    await watching(c, 10 * S);
    c.reg.get(SID).status = 'busy';
    await step(c, 280 * S);
    c.tr.addToolResult(SID, c.clock.now() - 2 * S);
    c.reg.get(SID).status = 'idle';
    await step(c, 1 * S);
    expect(c.sender.sent).toHaveLength(0);
    expect(c.mon.get(SID)!.mode).toBe('watching');
  });

  it('忙碌结束时仍满足到点条件且缓存未过期：立即发送', async () => {
    await watching(c, 10 * S);
    c.reg.get(SID).status = 'busy';
    await step(c, 270 * S); // 距最后请求 280 秒
    expect(c.sender.sent).toHaveLength(0);
    c.reg.get(SID).status = 'idle';
    await step(c, 1 * S);
    expect(c.sender.sent).toHaveLength(1);
  });

  it('修改间隔后按新间隔重新计算', async () => {
    await watching(c, 100 * S);
    c.settings.intervalSec = 120;
    expect(countdownMs(c.mon.get(SID)!, 120, c.clock.now())).toBe(20 * S);
    await step(c, 21 * S);
    expect(c.sender.sent).toHaveLength(1);
  });
});

describe('新请求与连续次数', () => {
  let c: Ctx;
  beforeEach(() => void (c = setup()));

  /** 跑一个完整的保活周期（到点发送 + 判定成功） */
  async function cycle(): Promise<void> {
    await step(c, 270 * S);
    await step(c, 1 * S);
  }

  it('本程序发送的消息及其引起的工具返回不打断连续次数', async () => {
    await watching(c, 10 * S);
    await step(c, 260 * S);
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.streak).toBe(1);
    // 目标会话处理这条消息时的工具调用返回
    c.tr.addToolResult(SID, c.clock.now() + 2 * S);
    await step(c, 5 * S);
    await cycle();
    expect(c.mon.get(SID)!.streak).toBe(2);
  });

  it('本程序自己的消息即使带 isMeta 也不打断连续次数', async () => {
    await watching(c, 10 * S);
    const orig = c.sender.send.bind(c.sender);
    c.sender.send = async (t, b) => {
      const r = await orig(t, b);
      const rec = c.tr.records.get(SID)!.at(-1)! as { isMeta: boolean };
      rec.isMeta = true;
      return r;
    };
    await step(c, 260 * S);
    await step(c, 1 * S);
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.streak).toBe(1);
  });

  it('人工输入是新请求：连续次数归零，倒计时重新起算，不发送', async () => {
    await watching(c, 10 * S);
    await cycle();
    expect(c.mon.get(SID)!.streak).toBe(1);
    await step(c, 200 * S);
    c.tr.addUser(SID, { timestamp: c.clock.now(), originKind: 'human' });
    await step(c, 100 * S); // 按旧起点早该发送，按新起点还差 170 秒
    expect(c.mon.get(SID)!.streak).toBe(0);
    expect(c.sender.sent).toHaveLength(1);
    expect(countdownMs(c.mon.get(SID)!, 270, c.clock.now())).toBe(170 * S);
  });

  it('其他会话发来的 peer 消息（msg_id 不是本程序的）也算新请求', async () => {
    await watching(c, 10 * S);
    await cycle();
    c.tr.addUser(SID, { timestamp: c.clock.now(), originKind: 'peer', originMsgId: 'someone-else' });
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.streak).toBe(0);
  });

  it('实测：peer 消息的记录带 isMeta: true，仍算新请求', async () => {
    await watching(c, 10 * S);
    await cycle();
    c.tr.addUser(SID, { timestamp: c.clock.now(), isMeta: true, originKind: 'peer', originMsgId: 'someone-else' });
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.streak).toBe(0);
  });

  it('没有 origin 的 isMeta 伴随记录和工具返回只刷新时间，不打断次数', async () => {
    await watching(c, 10 * S);
    await cycle();
    c.tr.addUser(SID, { timestamp: c.clock.now(), isMeta: true });
    c.tr.addToolResult(SID, c.clock.now());
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.streak).toBe(1);
  });

  it('连续次数达到 floor(7200 / 间隔) 后停止发送并通知', async () => {
    await watching(c, 10 * S);
    for (let i = 0; i < 26; i++) await cycle();
    const s = c.mon.get(SID)!;
    expect(s.streak).toBe(26);
    expect(s.mode).toBe('capped');
    expect(c.notices).toHaveLength(1);
    expect(c.notices[0]).toMatchObject({ kind: 'capped', sessionId: SID });
    expect(c.notices[0]!.body).toContain('26');
    const sent = c.sender.sent.length;
    await step(c, 600 * S);
    expect(c.sender.sent).toHaveLength(sent);
    expect(c.mon.get(SID)!.mode).toBe('capped');
  });

  it('达到上限后取消再勾选恢复', async () => {
    await watching(c, 10 * S);
    for (let i = 0; i < 26; i++) await cycle();
    c.mon.uncheck(SID);
    await c.mon.check(SID);
    expect(c.mon.get(SID)!.mode).toBe('watching');
    expect(c.mon.get(SID)!.streak).toBe(0);
  });

  it('上限随间隔变化：间隔改小后上限变大', async () => {
    c.settings.intervalSec = 290;
    await watching(c, 10 * S);
    for (let i = 0; i < 24; i++) {
      await step(c, 290 * S);
      await step(c, 1 * S);
    }
    expect(c.mon.get(SID)!.mode).toBe('capped');
    expect(c.mon.get(SID)!.streak).toBe(24);
  });

  it('间隔改大使上限变小时，已有次数超过新上限即停止', async () => {
    c.settings.intervalSec = 60;
    await watching(c, 10 * S);
    for (let i = 0; i < 30; i++) {
      await step(c, 60 * S);
      await step(c, 1 * S);
    }
    expect(c.mon.get(SID)!.streak).toBe(30);
    c.settings.intervalSec = 290; // 上限 24 < 30
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('capped');
  });
});

describe('最后请求时间：并行工具（实测的故障场景）', () => {
  let c: Ctx;
  beforeEach(() => void (c = setup()));

  it('并行工具先返回的结果不算请求，等全部到齐后发出的请求才算', async () => {
    c.reg.add({ sessionId: SID, pid: 100, status: 'busy' });
    c.tr.addUser(SID, { timestamp: T0 - 600 * S }); // 请求 A
    c.tr.addAssistant(SID, T0 - 598 * S); // 两个并行 tool_use
    c.tr.addAssistant(SID, T0 - 597 * S);
    await c.mon.check(SID);
    expect(c.mon.get(SID)!.lastRequestAt).toBe(T0 - 600 * S);

    c.tr.addToolResult(SID, T0 - 480 * S, false); // 第一个工具返回，另一个还在跑
    await c.mon.tick();
    expect(c.mon.get(SID)!.lastRequestAt).toBe(T0 - 600 * S);

    c.tr.addToolResult(SID, T0 - 300 * S, false); // 第二个返回：还没有回复，无法确认请求已发出
    await c.mon.tick();
    expect(c.mon.get(SID)!.lastRequestAt).toBe(T0 - 600 * S);

    c.tr.addAssistant(SID, T0 - 290 * S); // 回复出现，说明 T0-300 发出了请求
    await c.mon.tick();
    expect(c.mon.get(SID)!.lastRequestAt).toBe(T0 - 300 * S);
  });

  it('用并行结果之后的时间提醒，而不是被先返回的结果拖后', async () => {
    c.reg.add({ sessionId: SID, pid: 100, status: 'busy' });
    c.tr.addUser(SID, { timestamp: T0 - 10 * S });
    c.tr.addAssistant(SID, T0 - 8 * S);
    await c.mon.check(SID);
    await step(c, 120 * S);
    c.tr.addToolResult(SID, c.clock.now(), false); // 先返回的结果
    await step(c, 150 * S); // 距真正的最后请求 280 秒
    expect(c.notices.filter((n) => n.kind === 'stalled')).toHaveLength(1);
  });
});

describe('忙碌时缓存即将失效的提醒', () => {
  let c: Ctx;
  beforeEach(() => void (c = setup()));

  it('忙碌且距上次请求达到 4:30：提醒一次，不发送；之后不重复', async () => {
    await watching(c, 10 * S);
    c.reg.get(SID).status = 'busy';
    await step(c, 200 * S); // 210 秒
    expect(c.notices).toHaveLength(0);
    await step(c, 60 * S); // 270 秒
    expect(c.notices).toHaveLength(1);
    expect(c.notices[0]).toMatchObject({ kind: 'stalled', sessionId: SID });
    expect(c.notices[0]!.body).toContain('「A」');
    expect(c.notices[0]!.body).toContain('4 分 30 秒');
    await step(c, 120 * S);
    await step(c, 120 * S);
    expect(c.notices).toHaveLength(1);
    expect(c.sender.sent).toHaveLength(0);
  });

  it('提醒按固定的 4:30，与空闲间隔设置无关', async () => {
    c.settings.intervalSec = 60;
    await watching(c, 10 * S);
    c.reg.get(SID).status = 'busy';
    await step(c, 120 * S);
    expect(c.notices).toHaveLength(0);
    await step(c, 150 * S);
    expect(c.notices).toHaveLength(1);
  });

  it('忙碌期间出现新请求（工具返回）后重新计时，再次拖到 4:30 会再提醒一次', async () => {
    await watching(c, 10 * S);
    c.reg.get(SID).status = 'busy';
    await step(c, 270 * S);
    expect(c.notices).toHaveLength(1);
    c.tr.addToolResult(SID, c.clock.now());
    await step(c, 1 * S);
    await step(c, 200 * S);
    expect(c.notices).toHaveLength(1);
    await step(c, 80 * S);
    expect(c.notices).toHaveLength(2);
  });

  it('会话空闲时不提醒（该发送的会发送）；回到空闲后清除标记', async () => {
    await watching(c, 10 * S);
    await step(c, 260 * S);
    expect(c.notices.filter((n) => n.kind === 'stalled')).toHaveLength(0);
    expect(c.sender.sent).toHaveLength(1);
  });

  it('已过期（已失效）、已取消勾选的会话不提醒', async () => {
    await watching(c, 7 * MIN);
    c.reg.get(SID).status = 'busy';
    await step(c, 600 * S);
    expect(c.notices).toHaveLength(0);
    c.mon.uncheck(SID);
    await step(c, 600 * S);
    expect(c.notices).toHaveLength(0);
  });
});

describe('缓存已过期', () => {
  let c: Ctx;
  beforeEach(() => void (c = setup()));

  it('确认后立即发送，之后按正常监控保活', async () => {
    await watching(c, 7 * MIN);
    expect(c.mon.get(SID)!.mode).toBe('expired');
    await c.mon.confirm(SID);
    expect(c.sender.sent).toHaveLength(1);
    await step(c, 1 * S);
    const s = c.mon.get(SID)!;
    expect(s.mode).toBe('watching');
    expect(s.streak).toBe(1);
    await step(c, 270 * S);
    await step(c, 1 * S);
    expect(c.sender.sent).toHaveLength(2);
  });

  it('监控过程中到点时发现已超过 5 分钟：进入已过期，不自动发送', async () => {
    await watching(c, 10 * S);
    c.reg.get(SID).status = 'busy';
    await step(c, 400 * S);
    c.reg.get(SID).status = 'idle';
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('expired');
    await step(c, 600 * S);
    expect(c.sender.sent).toHaveLength(0);
  });

  it('已过期期间出现新请求：回到监控中', async () => {
    await watching(c, 7 * MIN);
    c.tr.addUser(SID, { timestamp: c.clock.now(), originKind: 'human' });
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('watching');
  });

  it('只有已过期的会话才响应确认', async () => {
    await watching(c, 10 * S);
    await c.mon.confirm(SID);
    expect(c.sender.sent).toHaveLength(0);
  });
});

describe('发送失败', () => {
  let c: Ctx;
  beforeEach(() => void (c = setup()));

  it('held：停止自动发送，勾选保留，显示 status 和 reason，弹通知', async () => {
    c.sender.mode = 'none';
    await watching(c, 270 * S);
    await step(c, 1 * S);
    c.mon.onReceipt({ origMsgId: 'msg-1', status: 'held', reason: 'awaiting approval' });
    await step(c, 1 * S);
    const s = c.mon.get(SID)!;
    expect(s.mode).toBe('failed');
    expect(c.mon.isChecked(SID)).toBe(true);
    expect(s.lastResult).toMatchObject({ ok: false, status: 'held', reason: 'awaiting approval' });
    expect(c.notices).toHaveLength(1);
    expect(c.notices[0]!.body).toContain('「A」');
    expect(c.notices[0]!.body).toContain('held');
    expect(c.notices[0]!.body).toContain('awaiting approval');
    await step(c, 600 * S);
    expect(c.sender.sent).toHaveLength(1);
  });

  it('dropped 另显示 drop_reason', async () => {
    c.sender.mode = 'none';
    await watching(c, 270 * S);
    await step(c, 1 * S);
    c.mon.onReceipt({ origMsgId: 'msg-1', status: 'dropped', reason: 'dropped at inbox', dropReason: 'duplicate' });
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.lastResult).toMatchObject({ status: 'dropped', dropReason: 'duplicate' });
    expect(c.notices[0]!.body).toContain('duplicate');
  });

  it.each(['denied', 'expired'] as const)('%s 回执按失败处理', async (status) => {
    c.sender.mode = 'none';
    await watching(c, 270 * S);
    await step(c, 1 * S);
    c.mon.onReceipt({ origMsgId: 'msg-1', status, reason: 'r' });
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.lastResult?.status).toBe(status);
  });

  it('回执先于 send() 返回到达也能处理', async () => {
    c.sender.mode = 'none';
    c.sender.beforeReturn = (id) => c.mon.onReceipt({ origMsgId: id, status: 'held', reason: 'early' });
    await watching(c, 270 * S);
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('failed');
    expect(c.mon.get(SID)!.lastResult?.reason).toBe('early');
  });

  it('30 秒无回执且记录里没有匹配的 msgId：超时未送达', async () => {
    c.sender.mode = 'none';
    await watching(c, 270 * S);
    await step(c, 1 * S);
    await step(c, 29 * S);
    expect(c.mon.get(SID)!.mode).toBe('sending');
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('failed');
    expect(c.mon.get(SID)!.lastResult).toMatchObject({ ok: false, status: 'timeout' });
    expect(c.notices).toHaveLength(1);
  });

  it('超时前记录里出现匹配 msgId 即成功', async () => {
    c.sender.mode = 'none';
    await watching(c, 270 * S);
    await step(c, 1 * S);
    await step(c, 20 * S);
    c.tr.addUser(SID, { timestamp: c.clock.now(), originKind: 'peer', originMsgId: 'msg-1' });
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('watching');
    expect(c.mon.get(SID)!.streak).toBe(1);
    expect(c.notices).toHaveLength(0);
  });

  it('发送器抛异常：按失败处理并通知', async () => {
    c.sender.mode = 'throw';
    await watching(c, 270 * S);
    await step(c, 1 * S);
    const s = c.mon.get(SID)!;
    expect(s.mode).toBe('failed');
    expect(s.lastResult).toMatchObject({ status: 'error', reason: 'socket closed' });
    expect(c.notices).toHaveLength(1);
  });

  it('取消再勾选后恢复，次数归零', async () => {
    c.sender.mode = 'throw';
    await watching(c, 270 * S);
    await step(c, 1 * S);
    c.sender.mode = 'transcript';
    c.mon.uncheck(SID);
    c.tr.addUser(SID, { timestamp: c.clock.now() - 270 * S });
    await c.mon.check(SID);
    await step(c, 1 * S);
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.streak).toBe(1);
  });

  it('其他会话发来的回执（msgId 不认识）被忽略', async () => {
    await watching(c, 10 * S);
    c.mon.onReceipt({ origMsgId: 'unknown', status: 'held' });
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('watching');
  });
});

describe('会话退出与异常隔离', () => {
  let c: Ctx;
  beforeEach(() => void (c = setup()));

  it('注册文件消失：自动取消勾选并保留提示', async () => {
    await watching(c, 10 * S);
    c.reg.remove(SID);
    await step(c, 1 * S);
    const s = c.mon.get(SID)!;
    expect(s.mode).toBe('gone');
    expect(s.note).toContain('会话已退出');
    expect(c.mon.isChecked(SID)).toBe(false);
    await step(c, 600 * S);
    expect(c.sender.sent).toHaveLength(0);
  });

  it('进程已退出或套接字消失同样处理', async () => {
    await watching(c, 10 * S);
    c.reg.deadPids.add(100);
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('gone');
    c.reg.deadPids.clear();
    await c.mon.check(SID);
    c.reg.missingSockets.add('/tmp/cc-socks/100.sock');
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('gone');
  });

  it('发送中会话退出：转为已退出，不再判定', async () => {
    c.sender.mode = 'none';
    await watching(c, 270 * S);
    await step(c, 1 * S);
    c.reg.remove(SID);
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('gone');
    expect(c.notices).toHaveLength(0);
  });

  it('clearGone 清掉提示，会话回来后可重新勾选', async () => {
    await watching(c, 10 * S);
    c.reg.deadPids.add(100);
    await step(c, 1 * S);
    c.mon.clearGone();
    expect(c.mon.get(SID)).toBeUndefined();
  });

  it('单个会话读取记录出错，不影响其他会话', async () => {
    await watching(c, 270 * S);
    await watching(c, 270 * S, 'b', 200);
    c.tr.failing.add(SID);
    await step(c, 1 * S);
    expect(c.sender.sent.map((x) => x.target.sessionId)).toEqual(['b']);
  });

  it('单个会话发送出错，不影响其他会话', async () => {
    await watching(c, 270 * S);
    await watching(c, 270 * S, 'b', 200);
    const orig = c.sender.send.bind(c.sender);
    c.sender.send = async (t, body) => {
      if (t.sessionId === SID) throw new Error('boom');
      return orig(t, body);
    };
    await step(c, 1 * S);
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('failed');
    expect(c.mon.get('b')!.mode).toBe('watching');
    expect(c.mon.get('b')!.streak).toBe(1);
  });

  it('读注册目录失败时本轮跳过，不改变状态', async () => {
    await watching(c, 10 * S);
    c.reg.listError = new Error('EIO');
    await step(c, 1 * S);
    expect(c.mon.get(SID)!.mode).toBe('watching');
  });

  it('stopAll 清空所有监控', async () => {
    await watching(c, 10 * S);
    await watching(c, 10 * S, 'b', 200);
    c.mon.stopAll();
    expect(c.mon.states()).toHaveLength(0);
    await step(c, 600 * S);
    expect(c.sender.sent).toHaveLength(0);
  });
});
