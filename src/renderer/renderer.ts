import type { GroupView, SessionRowView } from '../core/catalog';
import { coarseDuration, describeFailure, humanDuration } from '../core/format';
import { CACHE_TTL_MS, formatInterval } from '../core/settings';
import type { Candidate } from '../core/catalog';
import { formatProgress } from '../core/update';
import type { KeepaliveApi, UiState, UpdateState } from '../shared/ipc';

const api = (window as unknown as { keepalive: KeepaliveApi }).keepalive;
const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

const ICON = {
  chev: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>',
  folder: '<svg class="gico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/></svg>',
  up: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11V3M3.5 6.5 7 3l3.5 3.5"/></svg>',
  down: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v8M3.5 7.5 7 11l3.5-3.5"/></svg>',
  x: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>',
  plus: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M7 2.5v9M2.5 7h9"/></svg>',
};

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const hms = (t: number) => new Date(t).toTimeString().slice(0, 8);

const STATUS_TEXT: Record<string, string> = {
  idle: '空闲',
  busy: '对话进行中',
  waiting: '等待你的操作',
  shell: 'shell 运行中',
};

/** 只在值变化时写入，避免打断悬停、焦点和选中 */
function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** 让 parent 的子节点顺序与 want 一致，尽量不动已在正确位置的节点 */
function syncChildren(parent: Element, want: Element[]): void {
  want.forEach((el, i) => {
    if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
  });
  while (parent.children.length > want.length) parent.lastElementChild?.remove();
}

/* ======================= 会话行 ======================= */

/** 未勾选的会话显示固定的时刻而不是逐秒变化的"X 前"；缓存已失效的时长只按小时、天粗略显示 */
function clockText(t: number, now: number): string {
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const hms2 = d.toTimeString().slice(0, 8);
  return sameDay ? hms2 : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hms2.slice(0, 5)}`;
}

function sinceText(r: SessionRowView, gone: boolean, now: number): string {
  if (gone) return r.mode === 'gone' ? '会话已退出' : '未运行';
  if (r.status === 'busy' || r.status === 'waiting' || r.status === 'shell') return STATUS_TEXT[r.status] as string;
  if (r.ageMs === null || r.lastRequestAt === null) return '暂无请求记录';
  if (r.coldMs > 0) return `缓存已失效 ${coarseDuration(r.coldMs)}`;
  return r.checked ? `最后请求 ${humanDuration(r.ageMs)} 前` : `最后请求 ${clockText(r.lastRequestAt, now)}`;
}

interface RowEl {
  li: HTMLLIElement;
  html: string;
}
const rowEls = new Map<string, RowEl>();

function buildRow(r: SessionRowView): RowEl {
  const li = document.createElement('li');
  li.className = 'row-s';
  li.dataset.id = r.id;
  li.innerHTML = `
    <label class="chk"><input type="checkbox" aria-label="监控此会话"></label>
    <div class="who">
      <div class="name"></div>
      <div class="dir"></div>
      <div class="meta"><i class="dot"></i><span class="st"></span><span class="sid"></span></div>
    </div>
    <div class="life">
      <div class="track"><div class="fill"></div><div class="zone"></div><i class="tick"></i></div>
      <div class="since"></div>
    </div>
    <div class="count-cell"><div class="bigline"><div class="big"></div><span class="unit"></span></div><div class="cap"></div><div class="bars" hidden><i></i></div></div>
    <div class="result"></div>
    <button class="iconbtn rm" data-rm type="button" title="从监控中移除" aria-label="移除监控">${ICON.x}</button>`;
  return { li, html: '' };
}

function updateRow(re: RowEl, r: SessionRowView, s: UiState): void {
  const li = re.li;
  const gone = r.mode === 'gone' || r.mode === 'unavailable';
  setAttr(li, 'data-mode', gone ? 'gone' : r.mode === 'watching' ? 'watch' : r.mode);

  const cb = $<HTMLInputElement>('input', li);
  if (cb.checked !== r.checked) cb.checked = r.checked;
  cb.disabled = !r.available || gone;

  setText($('.name', li), r.name);
  setAttr($('.name', li), 'title', r.name);
  const dir = $('.dir', li);
  setText(dir, r.subPath);
  dir.hidden = r.subPath === '';
  setAttr(dir, 'title', r.cwd);
  setText($('.sid', li), r.shortId);
  setAttr($('.sid', li), 'title', `local_${r.id}`);
  setAttr($('[data-rm]', li), 'aria-label', `移除监控 ${r.name}`);
  setAttr($('.dot', li), 'data-s', gone ? 'off' : (r.status ?? 'idle'));
  setText($('.meta .st', li), gone ? '不可用' : STATUS_TEXT[r.status ?? 'idle'] ?? (r.status as string));

  /* 缓存余温条 */
  const age = r.ageMs;
  const tp = (s.intervalSec * 1000) / CACHE_TTL_MS * 100;
  const fill = $('.fill', li);
  fill.style.width = `${age === null ? 0 : (Math.min(age, CACHE_TTL_MS) / CACHE_TTL_MS) * 100}%`;
  setAttr(fill, 'data-cold', String(age !== null && age > CACHE_TTL_MS));
  $('.tick', li).style.left = `calc(${tp}% - 1px)`;
  $('.zone', li).style.left = `${tp}%`;
  setAttr($('.track', li), 'title', `发送点 ${formatInterval(s.intervalSec)}`);
  setText($('.since', li), sinceText(r, gone, s.now));

  /* 倒计时 */
  const big = $('.big', li);
  const cap = $('.cap', li);
  const bars = $('.bars', li);
  const unit = $('.unit', li);
  let unitText = '';
  let bigText = '—';
  let bigCls = 'big dim';
  let capText = '';
  let showBars = false;
  let capWarn = false;
  const streak = (lead: string) => {
    capText = `${lead ? `${lead}\n` : ''}已连续 ${r.streak} / ${r.cap}`;
    showBars = true;
  };
  if (gone) {
    /* 默认 */
  } else if (r.mode === 'off') {
    capText = '未监控';
  } else if (r.mode === 'watching' && r.waitingIdle) {
    bigText = '等待空闲';
    bigCls = 'big text';
    streak(r.stall === 'expired' ? '缓存已失效' : r.stall === 'soon' ? '缓存即将失效，忙碌中无法保活' : '空闲后再判断');
    capWarn = r.stall !== 'none';
  } else if (r.mode === 'watching') {
    bigText = mmss(r.countdownMs ?? 0);
    bigCls = 'big';
    unitText = '后发送';
    streak('');
  } else if (r.mode === 'sending') {
    bigText = '发送中';
    bigCls = 'big text';
    streak('');
  } else if (r.mode === 'expired') {
    bigText = '已失效';
    bigCls = 'big text cold';
    capText = '等待你确认';
  } else if (r.mode === 'failed') {
    bigText = '已停止';
    bigCls = 'big text bad';
    capText = '取消勾选再勾选可恢复';
  } else if (r.mode === 'capped') {
    bigText = '已达上限';
    bigCls = 'big text good';
    streak('取消勾选再勾选可恢复');
  }
  setText(big, bigText);
  setText(unit, unitText);
  setAttr(big, 'class', bigCls);
  setText(cap, capText);
  cap.classList.toggle('warn', capWarn);
  bars.hidden = !showBars;
  $('i', bars).style.width = `${r.cap > 0 ? Math.min(100, (r.streak / r.cap) * 100) : 0}%`;

  /* 最近一次发送 */
  let html: string;
  const res = r.result;
  if (r.mode === 'gone') {
    html = `<div class="res-bad">会话已退出</div><div class="res-text">勾选已自动取消</div>`;
  } else if (r.pendingRestore) {
    html = `<div class="res-text">打开后自动恢复监控</div>`;
  } else if (r.mode === 'expired') {
    html = `<div class="res-text">缓存已超过 5 分钟，现在发送会按未命中缓存计费。</div><button class="btn primary" data-confirm type="button">确认并发送</button>`;
  } else if (r.mode === 'sending') {
    html = `<div class="res-text">正在发送「${esc(s.content)}」…</div>`;
  } else if (!res) {
    html = `<div class="res-none">尚未发送</div>`;
  } else if (res.ok) {
    html = `<div class="res-ok">${hms(res.at)} 已送达</div>`;
  } else {
    const f = describeFailure(res);
    html = `<div class="res-bad">${esc(f.title)}</div>${f.detail ? `<div class="res-text">${esc(f.detail)}</div>` : ''}`;
  }
  if (re.html !== html) {
    $('.result', li).innerHTML = html;
    re.html = html;
  }
}

/* ======================= 目录分组 ======================= */

interface GroupEl {
  li: HTMLLIElement;
  rows: HTMLUListElement;
  empty: HTMLLIElement;
}
const groupEls = new Map<string, GroupEl>();

function buildGroup(path: string): GroupEl {
  const li = document.createElement('li');
  li.className = 'grp';
  li.dataset.path = path;
  li.innerHTML = `
    <div class="ghead">
      <button class="chev" type="button">${ICON.chev}</button>
      ${ICON.folder}
      <span class="gname"></span>
      <span class="gsum"></span>
      <span class="gact">
        <button class="iconbtn" data-act="add" type="button" title="添加会话">${ICON.plus}</button>
        <button class="iconbtn" data-act="up" type="button" title="上移">${ICON.up}</button>
        <button class="iconbtn" data-act="down" type="button" title="下移">${ICON.down}</button>
        <button class="iconbtn" data-act="rm" type="button" title="移除工作区，停止其下所有会话的监控">${ICON.x}</button>
      </span>
    </div>
    <ul class="grows"></ul>`;
  const empty = document.createElement('li');
  empty.className = 'gempty';
  empty.innerHTML = '还没有监控的会话<button class="btn sm" data-act="add-empty" type="button">添加会话</button>'; // 常驻可见，空工作区不依赖悬停
  return { li, rows: $('.grows', li) as HTMLUListElement, empty };
}

function updateGroup(ge: GroupEl, g: GroupView): void {
  const li = ge.li;
  setAttr(li, 'data-collapsed', String(g.collapsed));
  const head = $('.ghead', li);
  setAttr(head, 'title', g.path);
  setText($('.gname', li), g.label);
  const chev = $('.chev', li);
  setAttr(chev, 'aria-expanded', String(!g.collapsed));
  setAttr(chev, 'aria-label', `${g.collapsed ? '展开' : '折叠'} ${g.label}`);
  const up = $<HTMLButtonElement>('[data-act=up]', li);
  const down = $<HTMLButtonElement>('[data-act=down]', li);
  up.disabled = !g.canMoveUp;
  down.disabled = !g.canMoveDown;
  setAttr(up, 'aria-label', `上移 ${g.label}`);
  setAttr(down, 'aria-label', `下移 ${g.label}`);
  setAttr($('[data-act=rm]', li), 'aria-label', `移除 ${g.label}`);
  setAttr($('[data-act=add]', li), 'aria-label', `添加会话到 ${g.label}`);

  const sm = g.summary;
  const parts: string[] = [];
  if (sm.monitoring) parts.push(`<span class="mon">监控中 ${sm.monitoring}</span>`);
  if (sm.expired) parts.push(`<span class="cold">已失效 ${sm.expired}</span>`);
  if (sm.failed) parts.push(`<span class="bad">失败 ${sm.failed}</span>`);
  const sum = $('.gsum', li);
  const html = parts.join('');
  if (sum.innerHTML !== html) sum.innerHTML = html;
}

/* ======================= 渲染 ======================= */

const rowsEl = $('#rows');
let latest: UiState | null = null;

function render(s: UiState): void {
  latest = s;
  const none = s.groups.length === 0;
  $('#empty').hidden = !none;
  $('#cols').hidden = none;

  const seenGroups = new Set<string>();
  const seenRows = new Set<string>();
  const groupList: HTMLElement[] = [];
  for (const g of s.groups) {
    seenGroups.add(g.path);
    let ge = groupEls.get(g.path);
    if (!ge) groupEls.set(g.path, (ge = buildGroup(g.path)));
    updateGroup(ge, g);
    const rowList: HTMLElement[] = [];
    for (const r of g.rows) {
      seenRows.add(r.id);
      let re = rowEls.get(r.id);
      if (!re) rowEls.set(r.id, (re = buildRow(r)));
      updateRow(re, r, s);
      rowList.push(re.li);
    }
    syncChildren(ge.rows, rowList.length ? rowList : [ge.empty]);
    groupList.push(ge.li);
  }
  syncChildren(rowsEl, groupList);
  for (const id of [...rowEls.keys()]) if (!seenRows.has(id)) rowEls.delete(id);
  for (const p of [...groupEls.keys()]) if (!seenGroups.has(p)) groupEls.delete(p);

  syncSettings(s);
}

/* ======================= 设置区 ======================= */

const contentEl = $<HTMLInputElement>('#content');
const ifieldEl = $('#ifield');
const conerrEl = $('#conerr');
const intervalEl = $<HTMLInputElement>('#interval');
const interrEl = $('#interr');
const bannerEl = $('#banner');

const editing = () => ifieldEl.dataset.state === 'edit';

function syncSettings(s: UiState): void {
  if (!editing() && contentEl.value !== s.content) contentEl.value = s.content; // 编辑中不覆盖正在输入的内容
  if (document.activeElement !== intervalEl) {
    const v = formatInterval(s.intervalSec);
    if (intervalEl.value !== v) intervalEl.value = v;
    intervalEl.setAttribute('aria-invalid', 'false');
    setText(interrEl, '');
  }
  bannerEl.hidden = s.peerError === null;
  setText(bannerEl, s.peerError ?? '');
}

/* 发送内容：默认只读，点铅笔编辑，对号保存（回车）、叉号取消（Esc）；编辑中不实时保存，点别处不会丢内容 */
function setEditing(on: boolean): void {
  ifieldEl.dataset.state = on ? 'edit' : 'view';
  contentEl.readOnly = !on;
  contentEl.value = latest?.content ?? contentEl.value;
  contentEl.setAttribute('aria-invalid', 'false');
  setText(conerrEl, '');
  if (on) {
    contentEl.focus();
    contentEl.select();
  } else {
    contentEl.blur();
  }
}
async function saveContent(): Promise<void> {
  const err = await api.setContent(contentEl.value);
  if (err !== null) {
    contentEl.setAttribute('aria-invalid', 'true'); // 校验不通过，留在编辑状态
    setText(conerrEl, err);
    return;
  }
  setEditing(false);
}
$('[data-edit]', ifieldEl).addEventListener('click', () => setEditing(true));
$('[data-ok]', ifieldEl).addEventListener('click', () => void saveContent());
$('[data-no]', ifieldEl).addEventListener('click', () => setEditing(false));
contentEl.addEventListener('keydown', (e) => {
  if (!editing()) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    void saveContent();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    setEditing(false);
  }
});

/* 空闲间隔保持直接编辑、实时校验 */
intervalEl.addEventListener('input', async () => {
  const err = await api.setInterval(intervalEl.value);
  intervalEl.setAttribute('aria-invalid', String(err !== null));
  setText(interrEl, err ?? '');
});
intervalEl.addEventListener('blur', () => {
  if (latest && intervalEl.getAttribute('aria-invalid') === 'true') {
    intervalEl.value = formatInterval(latest.intervalSec); // 不合法的值不保存，失焦后还原
    intervalEl.setAttribute('aria-invalid', 'false');
    setText(interrEl, '');
  }
});

/* ======================= 弹层（添加会话、检查更新共用） ======================= */

interface ModalAction {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  on: () => void;
}
interface ModalCfg {
  title: string;
  sub?: string;
  body: Node | string;
  actions: ModalAction[];
  /** 点遮罩、按 Esc 时的动作；不给就不允许这样关闭 */
  onEsc?: () => void;
}
const modalEl = $('#modal');
const modal = {
  cfg: null as ModalCfg | null,
  open(cfg: ModalCfg): void {
    this.cfg = cfg;
    setText($('#m-title'), cfg.title);
    const sub = $('#m-sub');
    setText(sub, cfg.sub ?? '');
    sub.hidden = !cfg.sub;
    const body = $('#m-body');
    if (typeof cfg.body === 'string') body.innerHTML = cfg.body;
    else body.replaceChildren(cfg.body);
    this.actions(cfg.actions);
    modalEl.hidden = false;
  },
  actions(list: ModalAction[]): void {
    const foot = $('#m-foot');
    foot.replaceChildren(
      ...list.map((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn${a.primary ? ' primary' : ''}`;
        b.textContent = a.label;
        b.disabled = a.disabled === true;
        b.addEventListener('click', a.on);
        return b;
      }),
    );
    foot.hidden = list.length === 0;
    $<HTMLButtonElement>('.primary:not(:disabled)', foot)?.focus();
  },
  close(): void {
    modalEl.hidden = true;
    this.cfg = null;
  },
};
modalEl.addEventListener('mousedown', (e) => {
  if (e.target === modalEl) modal.cfg?.onEsc?.();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') modal.cfg?.onEsc?.();
});

/** 添加会话（需求 5.5）：只显示标题和会话号 */
let addToken = 0;
async function openAdd(dirPath: string, label: string): Promise<void> {
  const token = ++addToken;
  const { items, degraded } = await api.listCandidates(dirPath);
  if (token !== addToken) return;
  const sel = new Set<string>();
  const body = document.createElement('div');
  if (items.length === 0) body.innerHTML = '<div class="mnone">没有可添加的会话</div>';
  for (const c of items as Candidate[]) {
    const row = document.createElement('label');
    row.className = 'citem';
    row.innerHTML = `<input type="checkbox"><span class="ct"></span><code></code>`;
    setText($('.ct', row), c.title);
    setAttr($('.ct', row), 'title', c.title);
    setText($('code', row), c.shortId);
    setAttr($('code', row), 'title', `local_${c.id}`);
    $('input', row).addEventListener('change', (e) => {
      if ((e.target as HTMLInputElement).checked) sel.add(c.id);
      else sel.delete(c.id);
      refreshActions();
    });
    body.append(row);
  }
  if (degraded) {
    const n = document.createElement('div');
    n.className = 'mnote';
    n.textContent = '未能读取桌面版会话存储，仅列出正在运行的会话';
    body.append(n);
  }
  const refreshActions = () =>
    modal.actions([
      { label: '取消', on: () => modal.close() },
      {
        label: sel.size ? `添加 ${sel.size} 个` : '添加',
        primary: true,
        disabled: sel.size === 0,
        on: () => {
          modal.close();
          void api.addSessions(dirPath, [...sel]);
        },
      },
    ]);
  modal.open({ title: '添加会话', sub: label, body, actions: [], onEsc: () => modal.close() });
  refreshActions();
}

/* ======================= 检查更新（需求第 14 节） ======================= */

function renderUpdate(u: UpdateState): void {
  if (u.step === 'idle') {
    if (modal.cfg?.title === UPDATE_TITLE) modal.close();
    return;
  }
  const text = (main: string, small?: string, bad = false) => {
    const d = document.createElement('div');
    d.className = `mtext${bad ? ' bad' : ''}`;
    d.textContent = main;
    if (small) {
      const s = document.createElement('small');
      s.textContent = small;
      d.append(s);
    }
    return d;
  };
  const act = (a: Parameters<KeepaliveApi['updateAction']>[0]) => () => void api.updateAction(a);
  const cancel: ModalAction = { label: '取消', on: act('cancel') };
  const okBtn: ModalAction = { label: '好', primary: true, on: act('close') };
  const open = (body: Node, actions: ModalAction[], escapable = true) =>
    modal.open({ title: UPDATE_TITLE, body, actions, ...(escapable ? { onEsc: act('cancel') } : {}) });
  switch (u.step) {
    case 'checking':
      open(text('正在检查更新…'), [cancel]);
      break;
    case 'latest':
      open(text(`当前已是最新版本 v${u.current}`), [okBtn]);
      break;
    case 'available':
      open(text(`发现新版本 v${u.latest}（当前 v${u.current}）`), [cancel, { label: '更新', primary: true, on: act('update') }]);
      break;
    case 'downloading': {
      const body = document.createElement('div');
      body.append(text(`正在下载 v${u.latest}…`));
      const prog = document.createElement('div');
      prog.className = 'prog';
      const bar = document.createElement('i');
      bar.style.width = u.total ? `${Math.min(100, ((u.received ?? 0) / u.total) * 100)}%` : '0%';
      prog.append(bar);
      body.append(prog, text(`已下载 ${formatProgress(u.received ?? 0, u.total)}`));
      open(body, [cancel]);
      break;
    }
    case 'ready':
      open(
        text(
          `v${u.latest} 已下载完成，安装后应用会自动重启`,
          u.monitoring ? `当前有 ${u.monitoring} 个会话在监控，监控会在重启后自动恢复，连续次数归零。` : undefined,
        ),
        [cancel, { label: '安装', primary: true, on: act('install') }],
      );
      break;
    case 'installing':
      open(text('正在安装，应用即将重启…'), [], false);
      break;
    case 'manual':
      open(text(u.message ?? '', u.detail), [okBtn]);
      break;
    case 'error': {
      const actions: ModalAction[] = [{ label: '关闭', on: act('close') }];
      if (u.retry) actions.unshift({ label: '重试', primary: true, on: act('retry') });
      open(text(u.message ?? '更新失败', undefined, true), actions);
      break;
    }
  }
}
const UPDATE_TITLE = 'Keepwarm 更新';

/* ======================= 交互 ======================= */

rowsEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>('.row-s');
  const grp = target.closest<HTMLElement>('.grp');
  if (row && target.closest('[data-confirm]')) {
    void api.confirm(row.dataset.id as string);
    return;
  }
  if (row && grp && target.closest('[data-rm]')) {
    void api.removeSession(grp.dataset.path as string, row.dataset.id as string);
    return;
  }
  if (grp && target.closest('[data-act=add-empty]')) {
    void openAdd(grp.dataset.path as string, $('.gname', grp).textContent ?? '');
    return;
  }
  if (!grp || !target.closest('.ghead')) return;
  const path = grp.dataset.path as string;
  const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'add') void openAdd(path, $('.gname', grp).textContent ?? '');
  else if (act === 'up') void api.moveDir(path, -1);
  else if (act === 'down') void api.moveDir(path, 1);
  else if (act === 'rm') void api.removeDir(path);
  else void api.setCollapsed(path, grp.dataset.collapsed !== 'true');
});

rowsEl.addEventListener('change', (e) => {
  const cb = e.target as HTMLInputElement;
  const row = cb.closest<HTMLElement>('.row-s');
  if (row && cb.type === 'checkbox') void api.setChecked(row.dataset.id as string, cb.checked);
});

$('#add-dir').addEventListener('click', () => void api.addDir());
$('#add-dir-empty').addEventListener('click', () => void api.addDir());
$('#refresh').addEventListener('click', (e) => {
  const b = e.currentTarget as HTMLElement;
  b.classList.remove('spin');
  void b.offsetWidth;
  b.classList.add('spin');
  void api.refresh();
});

api.onState(render);
void api.getState().then(render);
api.onUpdate(renderUpdate);
void api.getUpdateState().then(renderUpdate);
