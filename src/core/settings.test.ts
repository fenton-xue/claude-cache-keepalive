import { describe, expect, it } from 'vitest';
import {
  formatInterval,
  normalizeSettings,
  parseInterval,
  streakCap,
  validateContent,
  validateInterval,
} from './settings';

describe('parseInterval', () => {
  it.each([
    ['4:30', 270],
    ['04:30', 270],
    ['1:00', 60],
    ['270', 270],
    [' 4:50 ', 290],
  ])('解析 %s', (text, sec) => {
    expect(parseInterval(text)).toBe(sec);
  });
  it.each(['', 'abc', '4:5', '4:75', '4:30:00', '-1', '1.5', '4：30'])('拒绝 %s', (text) => {
    expect(parseInterval(text)).toBeNull();
  });
});

describe('validateInterval', () => {
  it('60 到 290 秒之间合法，含端点', () => {
    for (const s of [60, 61, 270, 290]) expect(validateInterval(s)).toBeNull();
  });
  it('超出范围或无法解析不合法', () => {
    for (const s of [0, 59, 291, 300, null]) expect(validateInterval(s)).toMatch(/1:00 到 4:50/);
  });
});

describe('streakCap / formatInterval', () => {
  it('默认 270 秒时为 26 次', () => {
    expect(streakCap(270)).toBe(26);
  });
  it('向下取整', () => {
    expect(streakCap(60)).toBe(120);
    expect(streakCap(290)).toBe(24);
    expect(streakCap(100)).toBe(72);
  });
  it('格式化', () => {
    expect(formatInterval(270)).toBe('4:30');
    expect(formatInterval(60)).toBe('1:00');
    expect(formatInterval(65)).toBe('1:05');
  });
});

describe('validateContent', () => {
  it('空白不合法', () => {
    expect(validateContent('')).not.toBeNull();
    expect(validateContent('  ')).not.toBeNull();
    expect(validateContent('1')).toBeNull();
  });
});

describe('normalizeSettings', () => {
  it('非对象回退默认值', () => {
    expect(normalizeSettings(null)).toEqual({ content: '1', intervalSec: 270, dirs: [] });
    expect(normalizeSettings('x')).toEqual({ content: '1', intervalSec: 270, dirs: [] });
  });
  it('坏字段逐项回退，目录去重并保留顺序和折叠状态', () => {
    const s = normalizeSettings({
      content: '  ping ',
      intervalSec: 10,
      dirs: [
        { path: '/a', collapsed: true },
        { path: '/b' },
        { path: '/a', collapsed: false },
        { path: '' },
        42,
      ],
    });
    expect(s.content).toBe('ping');
    expect(s.intervalSec).toBe(270);
    expect(s.dirs).toEqual([
      { path: '/a', collapsed: true },
      { path: '/b', collapsed: false },
    ]);
  });
  it('不会带出勾选状态等未知字段', () => {
    const s = normalizeSettings({ content: '1', intervalSec: 120, dirs: [], checked: ['x'] });
    expect(s).toEqual({ content: '1', intervalSec: 120, dirs: [] });
  });
});
