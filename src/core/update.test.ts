import { describe, expect, it } from 'vitest';
import {
  UpdateHttpError,
  compareVersions,
  describeUpdateError,
  formatProgress,
  parseRelease,
  parseSha256,
  parseVersion,
  pickAssets,
} from './update';

describe('版本比较', () => {
  it('按三段数字逐段比较，不是字符串比较', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.3.0', '0.2.0')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.2.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });
  it('本地版本更高（开发版）不算有更新；解析不了按相等', () => {
    expect(compareVersions('0.2.0', '0.3.0')).toBeLessThan(0);
    expect(compareVersions('abc', '0.2.0')).toBe(0);
    expect(parseVersion('v1.2.3-beta.1')).toEqual([1, 2, 3]);
    expect(parseVersion('latest')).toBeNull();
  });
});

describe('Release 解析与安装包挑选', () => {
  const raw = {
    tag_name: 'v0.3.0',
    assets: [
      { name: 'Keepwarm-0.3.0-arm64.dmg', browser_download_url: 'https://x/a.dmg' },
      { name: 'Keepwarm-0.3.0-arm64.dmg.sha256', browser_download_url: 'https://x/a.sha' },
      { name: 'other', browser_download_url: 'https://x/o' },
      { name: 5 },
    ],
  };
  it('去掉 v，整理资源', () => {
    const rel = parseRelease(raw)!;
    expect(rel.version).toBe('0.3.0');
    expect(rel.assets).toHaveLength(3);
    expect(parseRelease({ tag_name: 'nightly' })).toBeNull();
    expect(parseRelease(null)).toBeNull();
  });
  it('按架构挑 dmg 和 sha256，缺任何一个返回 null', () => {
    const rel = parseRelease(raw)!;
    expect(pickAssets(rel, 'arm64')!.dmg.url).toBe('https://x/a.dmg');
    expect(pickAssets(rel, 'arm64')!.sha.url).toBe('https://x/a.sha');
    expect(pickAssets(rel, 'x64')).toBeNull();
    expect(pickAssets({ ...rel, assets: rel.assets.slice(0, 1) }, 'arm64')).toBeNull();
  });
});

describe('校验文件与文案', () => {
  it('解析 shasum 输出', () => {
    const h = 'A'.repeat(64);
    expect(parseSha256(`${h}  Keepwarm-0.3.0-arm64.dmg\n`)).toBe('a'.repeat(64));
    expect(parseSha256('oops')).toBeNull();
    expect(parseSha256('abc123  file')).toBeNull();
  });
  it('失败文案', () => {
    expect(describeUpdateError(new UpdateHttpError(403))).toMatch(/过于频繁/);
    expect(describeUpdateError(new UpdateHttpError(404))).toMatch(/还没有发布/);
    expect(describeUpdateError(new UpdateHttpError(500))).toMatch(/HTTP 500/);
    expect(describeUpdateError(new TypeError('net::ERR_INTERNET_DISCONNECTED'))).toMatch(/无法连接/);
    expect(describeUpdateError(new Error('boom'))).toBe('boom');
  });
  it('进度文案', () => {
    expect(formatProgress(12.3 * 1048576, 45 * 1048576)).toBe('12.3 / 45.0 MB');
    expect(formatProgress(1048576, undefined)).toBe('1.0 MB');
  });
});
