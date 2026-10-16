import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTENT,
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
  const base = { schemaVersion: 2, content: DEFAULT_CONTENT, intervalSec: 270, dirs: [], checked: [] };
  it('非对象回退默认值（全新安装，不需要迁移）', () => {
    expect(normalizeSettings(null)).toEqual(base);
    expect(normalizeSettings('x')).toEqual(base);
  });
  it('坏字段逐项回退，工作区去重并保留顺序、折叠状态和成员', () => {
    const s = normalizeSettings({
      schemaVersion: 2,
      content: '  ping ',
      intervalSec: 10,
      dirs: [
        { path: '/a', collapsed: true, members: ['local_1', 'local_2', 'local_1', 5, ''] },
        { path: '/b' },
        { path: '/a', collapsed: false },
        { path: '' },
        42,
      ],
    });
    expect(s.content).toBe('ping');
    expect(s.intervalSec).toBe(270);
    expect(s.dirs).toEqual([
      { path: '/a', collapsed: true, members: ['local_1', 'local_2'] },
      { path: '/b', collapsed: false, members: [] },
    ]);
  });
  it('一个会话只属于一个工作区：后面的重复成员被丢弃', () => {
    const s = normalizeSettings({
      schemaVersion: 2,
      dirs: [
        { path: '/a', members: ['local_1'] },
        { path: '/b', members: ['local_1', 'local_2'] },
      ],
    });
    expect(s.dirs.map((d) => d.members)).toEqual([['local_1'], ['local_2']]);
  });
  it('记住的勾选集合：只保留仍是成员的，去重', () => {
    const s = normalizeSettings({
      schemaVersion: 2,
      dirs: [{ path: '/a', members: ['local_1', 'local_2'] }],
      checked: ['local_2', 'local_9', 'local_2', 7],
    });
    expect(s.checked).toEqual(['local_2']);
  });
  it('v1.3 及以前的文件（没有 schemaVersion）标为版本 1，目录保留、成员为空，等待迁移', () => {
    const s = normalizeSettings({ content: '1', intervalSec: 120, dirs: [{ path: '/a', collapsed: true }] });
    expect(s).toEqual({
      schemaVersion: 1,
      content: '1',
      intervalSec: 120,
      dirs: [{ path: '/a', collapsed: true, members: [] }],
      checked: [],
    });
  });
});
