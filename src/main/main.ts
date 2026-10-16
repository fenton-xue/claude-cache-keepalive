import { app, BrowserWindow, dialog, ipcMain, Menu, Notification } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OWN_NAME } from '../core/sessions';
import type { Notice } from '../core/types';
import { IPC, type UiState, type UpdateAction, type UpdateState } from '../shared/ipc';
import { CcPeerSender } from './ccPeerSender';
import { Controller } from './controller';
import { FsProbe, FsRegistry } from './fsRegistry';
import { FsSessionStore } from './fsSessionStore';
import { FsTranscripts } from './fsTranscripts';
import { SettingsStore } from './settingsStore';
import { cleanupStale } from './staleCleanup';
import { ElectronUpdateIo } from './updateIo';
import { Updater } from './updater';

app.setName(OWN_NAME);

const claudeDir = join(homedir(), '.claude');
const sessionsDir = join(claudeDir, 'sessions');
const projectsDir = join(claudeDir, 'projects');
const appSupport = join(homedir(), 'Library', 'Application Support');
const desktopSessionRoots = [join(appSupport, 'Claude', 'claude-code-sessions'), join(appSupport, 'Claude-3p', 'claude-code-sessions')];
const socketDir = '/tmp/cc-socks';

let win: BrowserWindow | null = null;
let controller: Controller | null = null;
let updater: Updater | null = null;
let sender: CcPeerSender | null = null;
let peerError: string | null = null;
let quitting = false;

const log = (msg: string, err?: unknown) => console.error(`[keepalive] ${msg}`, err ?? '');

function notify(n: Notice): void {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: n.title, body: n.body });
  note.on('click', showWindow);
  note.on('failed', (_e, err) => log(`notification failed: ${err}`));
  note.show();
}

function push(s: UiState): void {
  if (win && !win.isDestroyed()) win.webContents.send(IPC.state, s);
}

function pushUpdate(s: UpdateState): void {
  if (win && !win.isDestroyed()) win.webContents.send(IPC.update, s);
}

function showWindow(): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    createWindow();
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    title: OWN_NAME,
    backgroundColor: '#F2F3EF',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.on('closed', () => {
    win = null; // 关闭窗口不退出，监控继续
  });
  void win.loadFile(join(__dirname, '../renderer/index.html'));
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about', label: `关于 ${app.name}` },
          { type: 'separator' },
          {
            label: '检查更新…',
            click: () => {
              showWindow();
              updater?.begin();
            },
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: '工具',
        submenu: [
          {
            label: '发送测试通知',
            click: () =>
              notify({
                kind: 'failed',
                sessionId: '',
                title: 'Keepwarm：测试通知',
                body: '能看到这条，说明发送失败、达到上限时的通知可以正常弹出。',
              }),
          },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

async function shutdown(): Promise<void> {
  controller?.stop();
  try {
    // 清理注册文件、密钥文件、套接字；设上限避免退出被卡住
    await Promise.race([sender?.stop(), new Promise((r) => setTimeout(r, 3000))]);
  } catch (e) {
    log('peer stop failed', e);
  }
}

function quitCleanly(): void {
  if (quitting) return;
  quitting = true;
  void shutdown().finally(() => app.exit(0));
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // 两个实例会各自发送，只允许一个
} else {
  app.on('second-instance', showWindow);

  app.on('window-all-closed', () => {
    // 不退出：监控继续，Cmd+Q 才退出
  });
  app.on('activate', showWindow);
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitCleanly();
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, quitCleanly);
  process.on('uncaughtException', (e) => log('uncaughtException', e));
  process.on('unhandledRejection', (e) => log('unhandledRejection', e));

  void app.whenReady().then(async () => {
    buildMenu();
    // 开发模式（electron .）下 Dock 里默认是 Electron 的图标
    if (process.platform === 'darwin') app.dock?.setIcon(join(__dirname, 'icon.png'));

    // 清理上次崩溃遗留的、进程已不存在的本程序注册项
    const probe = new FsProbe();
    try {
      const removed = cleanupStale({ sessionsDir, socketDir, isPidAlive: (p) => probe.isPidAlive(p), ownPid: process.pid });
      if (removed.length) log(`cleaned stale files: ${removed.join(', ')}`);
    } catch (e) {
      log('stale cleanup failed', e);
    }

    const store = new SettingsStore(app.getPath('userData'));
    const peerSender = new CcPeerSender((r) => controller?.onReceipt(r));
    sender = peerSender;
    try {
      await peerSender.start();
    } catch (e) {
      peerError = `发送通道启动失败：${e instanceof Error ? e.message : String(e)}`;
      log('cc-peer start failed', e);
    }

    controller = new Controller({
      clock: { now: () => Date.now() },
      registry: new FsRegistry(sessionsDir),
      store: new FsSessionStore(desktopSessionRoots),
      probe,
      transcripts: new FsTranscripts(projectsDir),
      sender: peerSender,
      loadSettings: () => store.load(),
      saveSettings: (s) => store.save(s),
      notify,
      pickDirectory: async () => {
        const opts = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
        const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      push,
      getPeerError: () => peerError,
      log,
    });
    const c = controller;
    updater = new Updater({
      io: new ElectronUpdateIo(app.getPath('exe'), app.getPath('userData')),
      currentVersion: app.getVersion(),
      arch: process.arch === 'x64' ? 'x64' : 'arm64',
      isPackaged: app.isPackaged,
      monitoringCount: () => c.monitoringCount(),
      push: pushUpdate,
      quit: quitCleanly,
    });
    const u = updater;

    ipcMain.handle(IPC.getState, () => c.getState());
    ipcMain.handle(IPC.addDir, () => c.addDir());
    ipcMain.handle(IPC.removeDir, (_e, path: string) => c.removeDir(path));
    ipcMain.handle(IPC.moveDir, (_e, path: string, delta: -1 | 1) => c.moveDir(path, delta));
    ipcMain.handle(IPC.setCollapsed, (_e, path: string, v: boolean) => c.setCollapsed(path, v));
    ipcMain.handle(IPC.setContent, (_e, text: string) => c.setContent(String(text)));
    ipcMain.handle(IPC.setInterval, (_e, text: string) => c.setIntervalText(String(text)));
    ipcMain.handle(IPC.setChecked, (_e, id: string, on: boolean) => c.setChecked(id, on === true));
    ipcMain.handle(IPC.confirm, (_e, id: string) => c.confirm(id));
    ipcMain.handle(IPC.refresh, () => c.refresh());
    ipcMain.handle(IPC.listCandidates, (_e, path: string) => c.listCandidates(String(path)));
    ipcMain.handle(IPC.addSessions, (_e, path: string, ids: string[]) => c.addSessions(String(path), Array.isArray(ids) ? ids.map(String) : []));
    ipcMain.handle(IPC.removeSession, (_e, path: string, id: string) => c.removeSession(String(path), String(id)));
    ipcMain.handle(IPC.getUpdateState, () => u.getState());
    ipcMain.handle(IPC.updateAction, (_e, action: UpdateAction) => u.act(action));

    await c.start();
    createWindow();
  });
}
