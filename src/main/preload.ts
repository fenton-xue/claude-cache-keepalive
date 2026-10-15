import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type KeepaliveApi, type UiState } from '../shared/ipc';

const api: KeepaliveApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onState: (cb) => {
    const handler = (_e: unknown, s: UiState) => cb(s);
    ipcRenderer.on(IPC.state, handler);
    return () => ipcRenderer.removeListener(IPC.state, handler);
  },
  addDir: () => ipcRenderer.invoke(IPC.addDir),
  removeDir: (path) => ipcRenderer.invoke(IPC.removeDir, path),
  moveDir: (path, delta) => ipcRenderer.invoke(IPC.moveDir, path, delta),
  setCollapsed: (path, collapsed) => ipcRenderer.invoke(IPC.setCollapsed, path, collapsed),
  setContent: (text) => ipcRenderer.invoke(IPC.setContent, text),
  setInterval: (text) => ipcRenderer.invoke(IPC.setInterval, text),
  setChecked: (id, on) => ipcRenderer.invoke(IPC.setChecked, id, on),
  confirm: (id) => ipcRenderer.invoke(IPC.confirm, id),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
};

contextBridge.exposeInMainWorld('keepalive', api);
