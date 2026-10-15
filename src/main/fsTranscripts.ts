import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseUserRecord } from '../core/transcript';
import type { TranscriptPoll, TranscriptSource, UserRecord } from '../core/types';

const START_CHUNK = 64 * 1024;
const MAX_SCAN = 256 * 1024 * 1024;
/** 找不到记录文件后，多久之内不再重新扫描目录 */
const MISSING_RETRY_MS = 5000;

interface Cursor {
  path: string;
  /** 已处理到的字节位置，总是落在一行的开头 */
  offset: number;
  lastUser: UserRecord | null;
}

/**
 * 只读：在 ~/.claude/projects 的各子目录下按文件名 <sessionId>.jsonl 查找记录文件（不按 cwd 拼目录名）。
 * peekLast 无状态（按 size+mtime 缓存），poll 带游标，只读新增部分。
 */
export class FsTranscripts implements TranscriptSource {
  private readonly paths = new Map<string, string>();
  private readonly missingAt = new Map<string, number>();
  private readonly peekCache = new Map<string, { size: number; mtimeMs: number; last: UserRecord | null }>();
  private readonly cursors = new Map<string, Cursor>();

  constructor(
    private readonly projectsDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  locate(sessionId: string): string | undefined {
    const cached = this.paths.get(sessionId);
    if (cached && existsSync(cached)) return cached;
    this.paths.delete(sessionId);
    const missed = this.missingAt.get(sessionId);
    if (missed !== undefined && this.now() - missed < MISSING_RETRY_MS) return undefined;
    let dirs: string[];
    try {
      dirs = readdirSync(this.projectsDir);
    } catch {
      dirs = [];
    }
    for (const d of dirs) {
      const p = join(this.projectsDir, d, `${sessionId}.jsonl`);
      if (existsSync(p)) {
        this.paths.set(sessionId, p);
        this.missingAt.delete(sessionId);
        return p;
      }
    }
    this.missingAt.set(sessionId, this.now());
    return undefined;
  }

  async peekLast(sessionId: string): Promise<UserRecord | null | undefined> {
    const path = this.locate(sessionId);
    if (!path) return undefined;
    const st = statSync(path);
    const hit = this.peekCache.get(sessionId);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.last;
    const { last } = scanTail(path);
    this.peekCache.set(sessionId, { size: st.size, mtimeMs: st.mtimeMs, last });
    return last;
  }

  async poll(sessionId: string): Promise<TranscriptPoll | undefined> {
    const path = this.locate(sessionId);
    if (!path) return undefined;
    let cur = this.cursors.get(sessionId);
    if (!cur || cur.path !== path) {
      const { last, completeEnd } = scanTail(path);
      cur = { path, offset: completeEnd, lastUser: last };
      this.cursors.set(sessionId, cur);
      return { lastUser: last, appended: [] };
    }
    const size = statSync(path).size;
    if (size < cur.offset) {
      // 文件被截断或替换：重建基线
      const { last, completeEnd } = scanTail(path);
      cur.offset = completeEnd;
      cur.lastUser = last;
      return { lastUser: last, appended: [] };
    }
    if (size === cur.offset) return { lastUser: cur.lastUser, appended: [] };

    const buf = readRange(path, cur.offset, size);
    const nl = buf.lastIndexOf(0x0a);
    if (nl < 0) return { lastUser: cur.lastUser, appended: [] }; // 一行还没写完
    cur.offset += nl + 1;
    const appended: UserRecord[] = [];
    for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) {
      if (line === '') continue;
      const rec = parseUserRecord(line);
      if (rec) appended.push(rec);
    }
    const lastAppended = appended[appended.length - 1];
    if (lastAppended) cur.lastUser = lastAppended;
    return { lastUser: cur.lastUser, appended };
  }

  forget(sessionId: string): void {
    this.cursors.delete(sessionId);
  }
}

function readRange(path: string, start: number, end: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return got === buf.length ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/**
 * 从文件尾部向前找最后一条 user 记录，同时给出“最后一个完整行”的结束位置。
 * 工具返回的行可能很长，所以块大小逐步翻倍，直到找到或读完整个文件。
 */
export function scanTail(path: string): { last: UserRecord | null; completeEnd: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    let chunk = START_CHUNK;
    for (;;) {
      const start = Math.max(0, size - chunk);
      const buf = readRange(path, start, size);
      const lastNl = buf.lastIndexOf(0x0a);
      const completeEnd = lastNl < 0 ? (start === 0 ? 0 : -1) : start + lastNl + 1;
      if (completeEnd >= 0) {
        // 丢掉可能被截断的第一行（除非块从文件头开始）
        const body = buf.subarray(0, lastNl < 0 ? 0 : lastNl).toString('utf8');
        const lines = body.split('\n');
        if (start > 0) lines.shift();
        for (let i = lines.length - 1; i >= 0; i--) {
          const rec = lines[i] === '' ? null : parseUserRecord(lines[i] as string);
          if (rec) return { last: rec, completeEnd };
        }
        if (start === 0) return { last: null, completeEnd };
      }
      if (start === 0 || chunk >= MAX_SCAN) return { last: null, completeEnd: completeEnd >= 0 ? completeEnd : size };
      chunk *= 2;
    }
  } finally {
    closeSync(fd);
  }
}
