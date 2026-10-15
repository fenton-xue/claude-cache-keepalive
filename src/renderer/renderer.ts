// 阶段二占位：仅打印主进程推送的状态，阶段三替换为正式界面
import type { KeepaliveApi } from '../shared/ipc';
const api = (window as unknown as { keepalive: KeepaliveApi }).keepalive;
const out = document.getElementById('o') as HTMLElement;
api.onState((s) => (out.textContent = JSON.stringify(s, null, 2)));
void api.getState().then((s) => (out.textContent = JSON.stringify(s, null, 2)));
