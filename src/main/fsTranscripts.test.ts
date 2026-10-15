import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsTranscripts } from './fsTranscripts';

const SID = '6e8d4425-1853-4e73-a4da-6cf45a68a024';
let root: string;
let file: string;
let tr: FsTranscripts;
let clock = 0;

const iso = (s: number) => new Date(Date.UTC(2026, 9, 15, 8, 0, s)).toISOString();
const user = (s: number, extra: object = {}, content: unknown = 'hi') =>
  JSON.stringify({ type: 'user', timestamp: iso(s), message: { role: 'user', content }, ...extra }) + '\n';
const assistant = (s: number) => JSON.stringify({ type: 'assistant', timestamp: iso(s), message: { content: [] } }) + '\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'keepalive-tr-'));
  mkdirSync(join(root, '-Users-x-proj-a'));
  mkdirSync(join(root, '-Users-x-proj-b'));
  file = join(root, '-Users-x-proj-b', `${SID}.jsonl`); // 与 cwd 无关，按文件名找
  clock = 1000;
  tr = new FsTranscripts(root, () => clock);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('FsTranscripts.peekLast', () => {
  it('按文件名在所有子目录里查找；找不到返回 undefined', async () => {
    expect(await tr.peekLast(SID)).toBeUndefined();
    writeFileSync(file, user(1));
    clock += 10_000; // 越过负缓存时间
    expect((await tr.peekLast(SID))?.timestamp).toBe(Date.parse(iso(1)));
  });

  it('最后一条 user 记录（含工具返回），忽略其后的 assistant 等其他记录', async () => {
    writeFileSync(file, user(1) + user(5, {}, [{ type: 'tool_result', tool_use_id: 't' }]) + assistant(9));
    const r = await tr.peekLast(SID);
    expect(r).toMatchObject({ timestamp: Date.parse(iso(5)), isToolResult: true });
  });

  it('没有 user 记录返回 null', async () => {
    writeFileSync(file, assistant(1));
    expect(await tr.peekLast(SID)).toBeNull();
  });

  it('user 记录在很长的行之前，需要向前扩大读取范围', async () => {
    const big = JSON.stringify({ type: 'assistant', timestamp: iso(2), pad: 'x'.repeat(300_000) }) + '\n';
    writeFileSync(file, user(1) + big);
    expect((await tr.peekLast(SID))?.timestamp).toBe(Date.parse(iso(1)));
  });

  it('文件末尾是写了一半的行时忽略它', async () => {
    writeFileSync(file, user(1) + '{"type":"user","timest');
    expect((await tr.peekLast(SID))?.timestamp).toBe(Date.parse(iso(1)));
  });

  it('文件增长后返回新的结果', async () => {
    writeFileSync(file, user(1));
    expect((await tr.peekLast(SID))?.timestamp).toBe(Date.parse(iso(1)));
    appendFileSync(file, user(7));
    expect((await tr.peekLast(SID))?.timestamp).toBe(Date.parse(iso(7)));
  });
});

describe('FsTranscripts.poll', () => {
  it('第一次建立基线且不返回历史；之后只返回新增', async () => {
    writeFileSync(file, user(1) + user(2));
    const first = await tr.poll(SID);
    expect(first?.lastUser?.timestamp).toBe(Date.parse(iso(2)));
    expect(first?.appended).toEqual([]);

    expect((await tr.poll(SID))?.appended).toEqual([]);
    appendFileSync(file, assistant(3) + user(4, { origin: { kind: 'peer', msg_id: 'm1' } }));
    const next = await tr.poll(SID);
    expect(next?.appended).toHaveLength(1);
    expect(next?.appended[0]).toMatchObject({ originKind: 'peer', originMsgId: 'm1' });
    expect(next?.lastUser?.timestamp).toBe(Date.parse(iso(4)));
    expect((await tr.poll(SID))?.appended).toEqual([]);
  });

  it('半行不丢：写完整之后才出现，且只出现一次', async () => {
    writeFileSync(file, user(1));
    await tr.poll(SID);
    const line = user(2);
    appendFileSync(file, line.slice(0, 30));
    expect((await tr.poll(SID))?.appended).toEqual([]);
    appendFileSync(file, line.slice(30));
    expect((await tr.poll(SID))?.appended).toHaveLength(1);
    expect((await tr.poll(SID))?.appended).toEqual([]);
  });

  it('基线时末尾有半行，写完整后不会丢', async () => {
    const line = user(2);
    writeFileSync(file, user(1) + line.slice(0, 20));
    await tr.poll(SID);
    appendFileSync(file, line.slice(20));
    const r = await tr.poll(SID);
    expect(r?.appended.map((x) => x.timestamp)).toEqual([Date.parse(iso(2))]);
  });

  it('forget 后重新建立基线', async () => {
    writeFileSync(file, user(1));
    await tr.poll(SID);
    appendFileSync(file, user(2));
    tr.forget(SID);
    const r = await tr.poll(SID);
    expect(r?.appended).toEqual([]);
    expect(r?.lastUser?.timestamp).toBe(Date.parse(iso(2)));
  });

  it('文件被截断后重建基线', async () => {
    writeFileSync(file, user(1) + user(2) + user(3));
    await tr.poll(SID);
    truncateSync(file, 0);
    writeFileSync(file, user(9));
    const r = await tr.poll(SID);
    expect(r?.appended).toEqual([]);
    expect(r?.lastUser?.timestamp).toBe(Date.parse(iso(9)));
  });

  it('找不到记录文件返回 undefined', async () => {
    expect(await tr.poll('nope')).toBeUndefined();
  });
});
