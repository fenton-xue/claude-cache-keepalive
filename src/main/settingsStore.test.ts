import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT, defaultSettings } from '../core/settings';
import { SettingsStore } from './settingsStore';

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'keepalive-set-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SettingsStore', () => {
  it('没有文件时用默认值（全新安装，不需要迁移）', () => {
    expect(new SettingsStore(join(dir, 'new')).load()).toEqual({ schemaVersion: 2, content: DEFAULT_CONTENT, intervalSec: 270, dirs: [], checked: [] });
  });
  it('保存后重新加载，工作区顺序、折叠状态、成员和记住的勾选保留', () => {
    const s = new SettingsStore(join(dir, 'nested'));
    const v = {
      schemaVersion: 2,
      content: 'ping',
      intervalSec: 120,
      dirs: [
        { path: '/b', collapsed: true, members: ['local_1', 'local_2'] },
        { path: '/a', collapsed: false, members: [] },
      ],
      checked: ['local_2'],
    };
    s.save(v);
    expect(new SettingsStore(join(dir, 'nested')).load()).toEqual(v);
  });
  it('文件损坏时回退默认值', () => {
    writeFileSync(join(dir, 'settings.json'), '{oops');
    expect(new SettingsStore(dir).load().intervalSec).toBe(270);
  });
  it('v1.3 的设置文件原样读入，标为需要迁移', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ content: '旧内容', intervalSec: 200, dirs: [{ path: '/a', collapsed: true }] }));
    expect(new SettingsStore(dir).load()).toEqual({
      schemaVersion: 1,
      content: '旧内容',
      intervalSec: 200,
      dirs: [{ path: '/a', collapsed: true, members: [] }],
      checked: [],
    });
  });
  it('文件里只有设置字段，没有多余内容', () => {
    new SettingsStore(dir).save(defaultSettings());
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).sort()).toEqual(['checked', 'content', 'dirs', 'intervalSec', 'schemaVersion']);
  });
});
