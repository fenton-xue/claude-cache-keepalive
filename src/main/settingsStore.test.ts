import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from './settingsStore';

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'keepalive-set-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SettingsStore', () => {
  it('没有文件时用默认值', () => {
    expect(new SettingsStore(join(dir, 'new')).load()).toEqual({ content: '1', intervalSec: 270, dirs: [] });
  });
  it('保存后重新加载，目录顺序和折叠状态保留', () => {
    const s = new SettingsStore(join(dir, 'nested'));
    const v = { content: 'ping', intervalSec: 120, dirs: [{ path: '/b', collapsed: true }, { path: '/a', collapsed: false }] };
    s.save(v);
    expect(new SettingsStore(join(dir, 'nested')).load()).toEqual(v);
  });
  it('文件损坏时回退默认值', () => {
    writeFileSync(join(dir, 'settings.json'), '{oops');
    expect(new SettingsStore(dir).load().intervalSec).toBe(270);
  });
  it('文件里只有设置，没有勾选状态', () => {
    new SettingsStore(dir).save({ content: '1', intervalSec: 270, dirs: [] });
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).sort()).toEqual(['content', 'dirs', 'intervalSec']);
  });
});
