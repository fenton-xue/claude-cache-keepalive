import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type KeepaliveApi, type UiState, type UpdateState } from '../shared/ipc';

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
  listCandidates: (path) => ipcRenderer.invoke(IPC.listCandidates, path),
  addSessions: (path, ids) => ipcRenderer.invoke(IPC.addSessions, path, ids),
  removeSession: (path, id) => ipcRenderer.invoke(IPC.removeSession, path, id),
  getUpdateState: () => ipcRenderer.invoke(IPC.getUpdateState),
  onUpdate: (cb) => {
    const handler = (_e: unknown, s: UpdateState) => cb(s);
    ipcRenderer.on(IPC.update, handler);
    return () => ipcRenderer.removeListener(IPC.update, handler);
  },
  updateAction: (action) => ipcRenderer.invoke(IPC.updateAction, action),
};

contextBridge.exposeInMainWorld('keepalive', api);
