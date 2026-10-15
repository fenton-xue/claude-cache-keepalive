/**
 * 浏览器预览用的假后端：真实的 Controller / Monitor / Catalog + 假注册文件、假会话记录、假发送器。
 * 只用于开发时对照原型检查界面，不属于产品。通过 window.__demo 驱动各种场景。
 */
import { Controller } from '../../src/main/controller';
import { defaultSettings, normalizeSettings, type Settings } from '../../src/core/settings';
import { FakeClock, FakeRegistry, FakeTranscripts } from '../../src/core/testing/fakes';
import type { SendTarget, Sender } from '../../src/core/types';
import { IPC, type KeepaliveApi, type UiState } from '../../src/shared/ipc';

void IPC;
const W = '/Users/fenton/Documents/Workspace';
const SEED_DIRS = ['/Users/fenton/Documents/Claude', `${W}/TypescriptCode/claude-cache-keepalive`, `${W}/TypescriptCode/ones-page`, `${W}/FentonWorkspace`];
const CANDIDATES = [`${W}/emm`, '/Users/fenton/Documents/Codex/claude-cache-keepalive'];

let speed = 1;
const clock = new FakeClock(Date.now());
const reg = new FakeRegistry();
const tr = new FakeTranscripts();
const failKind = new Map<string, string>();
let controller: Controller;

class DemoSender implements Sender {
  private n = 0;
  async send(target: SendTarget): Promise<{ msgId: string }> {
    const msgId = `demo-${++this.n}`;
    const kind = failKind.get(target.sessionId);
    setTimeout(() => {
      if (kind === 'held' || kind === 'denied' || kind === 'dropped') {
        controller.onReceipt({
          origMsgId: msgId,
          status: kind,
          reason: kind === 'held' ? 'The recipient session is not in bypass mode; the message is held for review.' : 'demo reason',
          ...(kind === 'dropped' ? { dropReason: 'rate-limited' } : {}),
        });
      } else if (kind !== 'timeout') {
        tr.addUser(target.sessionId, { timestamp: clock.now(), originKind: 'peer', originMsgId: msgId });
      }
    }, 1400 / speed);
    return { msgId };
  }
}

const sess = (id: string, name: string, cwd: string, agoSec: number, over: Record<string, unknown> = {}) => {
  const pid = 1000 + reg.entries.length;
  reg.add({ sessionId: id, pid, name, cwd, ...over });
  tr.addUser(id, { timestamp: clock.now() - agoSec * 1000 });
};
const byName = (name: string) => reg.entries.find((e) => e.name === name);

function seed(): void {
  sess('0cfe2f58-0946-4519-80af-73812835f195', '打招呼', '/Users/fenton/Documents/Claude', 70);
  sess('6e8d4425-1853-4e73-a4da-6cf45a68a024', 'Claude 缓存保活需求文档', `${W}/TypescriptCode/claude-cache-keepalive`, 5, { status: 'busy' });
  sess('8a3c10de-6b42-4f17-93ad-5e0b7c21f9a6', '缓存保活原型调整', `${W}/TypescriptCode/claude-cache-keepalive/.claude/worktrees/ui-polish`, 100);
  sess('3b91a7c0-5d1e-4f82-9c14-aa27de6310f4', 'ones-page 重构', `${W}/TypescriptCode/ones-page`, 7 * 60);
  sess('91d2e6b4-77a0-4c35-8e0f-12c4b6a9d7e1', '周报整理', `${W}/FentonWorkspace`, 150);
  sess('c07f58aa-2e91-4d6b-b3a8-4f90e1d25c77', 'emm 调试', `${W}/emm`, 200);
  failKind.set('91d2e6b4-77a0-4c35-8e0f-12c4b6a9d7e1', 'held');
  setTimeout(() => {
    const e = byName('Claude 缓存保活需求文档');
    if (e) {
      e.status = 'idle';
      tr.addUser(e.sessionId, { timestamp: clock.now(), originKind: 'human' });
    }
  }, 45_000);
}

const KEY = 'keepalive-preview';
const subs = new Set<(s: UiState) => void>();
let pending = 0;
let candidateIdx = 0;

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalizeSettings(JSON.parse(raw));
  } catch {
    /* 用默认值 */
  }
  const d = defaultSettings();
  d.dirs = SEED_DIRS.map((path) => ({ path, collapsed: false }));
  return d;
}

seed();
controller = new Controller({
  clock,
  registry: reg,
  probe: reg,
  transcripts: tr,
  sender: new DemoSender(),
  loadSettings,
  saveSettings: (s) => localStorage.setItem(KEY, JSON.stringify(s)),
  notify: (n) => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:12px;right:12px;width:320px;padding:10px 12px;border-radius:12px;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.3);z-index:9;font:13px -apple-system';
    el.innerHTML = `<b>${n.title}</b><div style="color:#55606C">${n.body}</div>`;
    document.body.append(el);
    setTimeout(() => el.remove(), 6000);
    console.info('NOTIFY', n.title, n.body);
  },
  pickDirectory: async () => CANDIDATES[candidateIdx++] ?? null,
  push: (s) => subs.forEach((cb) => cb(s)),
  getPeerError: () => null,
});

const api: KeepaliveApi = {
  getState: async () => controller.getState(),
  onState: (cb) => {
    subs.add(cb);
    return () => subs.delete(cb);
  },
  addDir: () => controller.addDir(),
  removeDir: async (p) => controller.removeDir(p),
  moveDir: async (p, d) => controller.moveDir(p, d),
  setCollapsed: async (p, c) => controller.setCollapsed(p, c),
  setContent: async (t) => controller.setContent(t),
  setInterval: async (t) => controller.setIntervalText(t),
  setChecked: (id, on) => controller.setChecked(id, on),
  confirm: (id) => controller.confirm(id),
  refresh: () => controller.refresh(),
};
(window as unknown as { keepalive: KeepaliveApi }).keepalive = api;


setInterval(() => clock.advance(200 * speed), 200);
void controller.start();

(window as unknown as { __demo: unknown }).__demo = {
  speed: (n: number) => (speed = n),
  request: (name: string) => {
    const e = byName(name);
    if (e) tr.addUser(e.sessionId, { timestamp: clock.now(), originKind: 'human' });
  },
  busy: (name: string, on: boolean) => {
    const e = byName(name);
    if (e) e.status = on ? 'busy' : 'idle';
  },
  status: (name: string, st: 'idle' | 'busy' | 'waiting' | 'shell') => {
    const e = byName(name);
    if (e) e.status = st;
  },
  exit: (name: string) => {
    const e = byName(name);
    if (e) reg.deadPids.add(e.pid);
  },
  cold: (name: string) => {
    const e = byName(name);
    if (e) tr.records.get(e.sessionId)!.push({ timestamp: clock.now() - 320_000, isToolResult: false, isMeta: false });
  },
  fail: (name: string, kind: string) => {
    const e = byName(name);
    if (e) failKind.set(e.sessionId, kind);
  },
  reset: () => {
    localStorage.removeItem(KEY);
    location.reload();
  },
  controller,
};
