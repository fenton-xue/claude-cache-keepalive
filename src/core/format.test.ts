import { describe, expect, it } from 'vitest';
import { coarseDuration, describeFailure, humanDuration } from './format';

const H = 3_600_000;

describe('coarseDuration', () => {
  it('只在跨过整小时、整天时变化', () => {
    expect(coarseDuration(0)).toBe('不到 1 小时');
    expect(coarseDuration(59 * 60_000 + 59_000)).toBe('不到 1 小时');
    expect(coarseDuration(H)).toBe('1 小时');
    expect(coarseDuration(H + 59 * 60_000)).toBe('1 小时');
    expect(coarseDuration(2 * H)).toBe('2 小时');
    expect(coarseDuration(23 * H + 59 * 60_000)).toBe('23 小时');
    expect(coarseDuration(24 * H)).toBe('1 天');
    expect(coarseDuration(50 * H)).toBe('2 天');
  });
});

describe('humanDuration', () => {
  it('秒、分', () => {
    expect(humanDuration(45_000)).toBe('45 秒');
    expect(humanDuration(60_000)).toBe('1 分钟');
    expect(humanDuration(95_000)).toBe('1 分 35 秒');
  });
});

describe('describeFailure', () => {
  it('held 显示 status 和 reason；dropped 另带 drop_reason；超时只显示文案', () => {
    expect(describeFailure({ ok: false, at: 0, status: 'held', reason: 'r' })).toEqual({ title: '已挂起（held）', detail: 'r' });
    expect(describeFailure({ ok: false, at: 0, status: 'dropped', reason: 'r', dropReason: 'duplicate' }).detail).toBe('r；drop_reason: duplicate');
    expect(describeFailure({ ok: false, at: 0, status: 'timeout' })).toEqual({ title: '超时未送达', detail: '' });
  });
});
