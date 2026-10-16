import { describe, expect, it } from 'vitest';
import { UpdateHttpError, type ReleaseAsset } from '../core/update';
import type { UpdateState } from '../shared/ipc';
import { Updater, type UpdateIo } from './updater';

const SHA = 'a'.repeat(64);
const release = (tag: string) => ({
  tag_name: tag,
  assets: [
    { name: `Keepwarm-${tag.replace(/^v/, '')}-arm64.dmg`, browser_download_url: 'https://x/dmg' },
    { name: `Keepwarm-${tag.replace(/^v/, '')}-arm64.dmg.sha256`, browser_download_url: 'https://x/sha' },
  ],
});

function setup(opts: { current?: string; isPackaged?: boolean; latest?: unknown; downloadSha?: string; installResult?: 'restarting' | 'manual' } = {}) {
  const log: string[] = [];
  const states: UpdateState[] = [];
  let quit = 0;
  let gate: (() => void) | null = null;
  const io: UpdateIo = {
    fetchLatest: async () => {
      log.push('fetchLatest');
      if (opts.latest instanceof Error) throw opts.latest;
      return opts.latest ?? release('v0.3.0');
    },
    fetchText: async () => `${SHA}  Keepwarm.dmg\n`,
    download: async (_a: ReleaseAsset, signal, onProgress) => {
      log.push('download');
      onProgress(10 * 1048576, 40 * 1048576);
      if (gate === null && opts.downloadSha === 'hang') await new Promise<void>((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
      return { path: '/tmp/x.dmg', sha256: opts.downloadSha === 'bad' ? 'b'.repeat(64) : SHA };
    },
    discard: () => void log.push('discard'),
    install: async () => {
      log.push('install');
      return opts.installResult ?? 'restarting';
    },
  };
  const u = new Updater({
    io,
    currentVersion: opts.current ?? '0.2.0',
    arch: 'arm64',
    isPackaged: opts.isPackaged ?? true,
    monitoringCount: () => 3,
    push: (s) => void states.push(s),
    quit: () => void quit++,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { u, log, states, flush, quits: () => quit };
}

describe('Updater', () => {
  it('已是最新：版本相同或本地更高', async () => {
    for (const cur of ['0.3.0', '0.9.0']) {
      const t = setup({ current: cur });
      t.u.begin();
      await t.flush();
      expect(t.u.getState()).toMatchObject({ step: 'latest', current: cur });
      t.u.act('close');
      expect(t.u.getState().step).toBe('idle');
    }
  });

  it('完整流程：检查 → 发现新版本 → 更新 → 下载完成 → 安装 → 退出', async () => {
    const t = setup();
    t.u.begin();
    expect(t.states[0]!.step).toBe('checking');
    await t.flush();
    expect(t.u.getState()).toMatchObject({ step: 'available', latest: '0.3.0', current: '0.2.0' });
    t.u.act('update');
    await t.flush();
    expect(t.states.some((s) => s.step === 'downloading' && s.received === 10 * 1048576 && s.total === 40 * 1048576)).toBe(true);
    expect(t.u.getState()).toMatchObject({ step: 'ready', latest: '0.3.0', monitoring: 3 });
    t.u.act('install');
    await t.flush();
    expect(t.u.getState().step).toBe('installing');
    expect(t.quits()).toBe(1);
    t.u.act('cancel'); // 安装中不能取消
    expect(t.u.getState().step).toBe('installing');
  });

  it('下载完成后取消：删除已下载的文件，回到空闲', async () => {
    const t = setup();
    t.u.begin();
    await t.flush();
    t.u.act('update');
    await t.flush();
    t.u.act('cancel');
    expect(t.u.getState().step).toBe('idle');
    expect(t.log).toContain('discard');
    t.u.act('install'); // 空闲时的安装动作无效
    expect(t.log).not.toContain('install');
  });

  it('下载中取消：中止下载，不报错', async () => {
    const t = setup({ downloadSha: 'hang' });
    t.u.begin();
    await t.flush();
    t.u.act('update');
    await t.flush();
    expect(t.u.getState().step).toBe('downloading');
    t.u.act('cancel');
    await t.flush();
    expect(t.u.getState().step).toBe('idle');
  });

  it('校验失败：删除文件并提示，可重试', async () => {
    const t = setup({ downloadSha: 'bad' });
    t.u.begin();
    await t.flush();
    t.u.act('update');
    await t.flush();
    expect(t.u.getState()).toMatchObject({ step: 'error', retry: true });
    expect(t.u.getState().message).toMatch(/校验失败/);
    expect(t.log).toContain('discard');
  });

  it('网络失败、限流、没有 Release：显示对应文案；重试会重新检查', async () => {
    const t = setup({ latest: new TypeError('net::ERR_INTERNET_DISCONNECTED') });
    t.u.begin();
    await t.flush();
    expect(t.u.getState()).toMatchObject({ step: 'error', retry: true });
    expect(t.u.getState().message).toMatch(/无法连接到 GitHub/);
    t.u.act('retry');
    await t.flush();
    expect(t.log.filter((x) => x === 'fetchLatest')).toHaveLength(2);

    expect(setup({ latest: new UpdateHttpError(403) }).u.begin).toBeDefined();
    const t2 = setup({ latest: new UpdateHttpError(403) });
    t2.u.begin();
    await t2.flush();
    expect(t2.u.getState().message).toMatch(/过于频繁/);
    const t3 = setup({ latest: new UpdateHttpError(404) });
    t3.u.begin();
    await t3.flush();
    expect(t3.u.getState().message).toMatch(/还没有发布/);
  });

  it('响应无法识别、没有适用架构的安装包：失败且不可重试', async () => {
    const bad = setup({ latest: { nope: 1 } });
    bad.u.begin();
    await bad.flush();
    expect(bad.u.getState()).toMatchObject({ step: 'error' });

    const noAsset = setup({ latest: { tag_name: 'v0.3.0', assets: [] } });
    noAsset.u.begin();
    await noAsset.flush();
    noAsset.u.act('update');
    await noAsset.flush();
    expect(noAsset.u.getState()).toMatchObject({ step: 'error', retry: false });
    expect(noAsset.u.getState().message).toMatch(/没有适用于 arm64/);
  });

  it('开发模式：能检查，不能下载安装', async () => {
    const t = setup({ isPackaged: false });
    t.u.begin();
    await t.flush();
    expect(t.u.getState().step).toBe('available');
    t.u.act('update');
    await t.flush();
    expect(t.u.getState()).toMatchObject({ step: 'error', retry: false });
    expect(t.u.getState().message).toMatch(/开发模式/);
    expect(t.log).not.toContain('download');
  });

  it('没有写权限：降级为手动安装，不退出', async () => {
    const t = setup({ installResult: 'manual' });
    t.u.begin();
    await t.flush();
    t.u.act('update');
    await t.flush();
    t.u.act('install');
    await t.flush();
    expect(t.u.getState()).toMatchObject({ step: 'manual', message: '没有权限覆盖当前应用' });
    expect(t.quits()).toBe(0);
  });

  it('流程进行中再点菜单只重推当前状态，不会重复检查', async () => {
    const t = setup();
    t.u.begin();
    await t.flush();
    t.u.begin();
    expect(t.log.filter((x) => x === 'fetchLatest')).toHaveLength(1);
    expect(t.states.at(-1)!.step).toBe('available');
  });
});
