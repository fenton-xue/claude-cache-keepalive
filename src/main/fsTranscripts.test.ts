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

const toolResult = (s: number) => user(s, {}, [{ type: 'tool_result', tool_use_id: 't' }]);
const T = (s: number) => Date.parse(iso(s));

describe('FsTranscripts.peekLastRequest', () => {
  it('按文件名在所有子目录里查找；找不到返回 undefined', async () => {
    expect(await tr.peekLastRequest(SID)).toBeUndefined();
    writeFileSync(file, user(1));
    clock += 10_000; // 越过负缓存时间
    expect(await tr.peekLastRequest(SID)).toBe(T(1));
  });

  it('请求发起时间：user 记录之后出现 assistant 回复，取该 user 记录的时间（含工具返回）', async () => {
    writeFileSync(file, user(1) + assistant(2) + toolResult(5) + assistant(9));
    expect(await tr.peekLastRequest(SID)).toBe(T(5));
  });

  it('并行工具：先返回的结果不算，取最后一个结果的时间', async () => {
    writeFileSync(file, user(1) + assistant(2) + assistant(3) + toolResult(100) + toolResult(300) + assistant(310));
    expect(await tr.peekLastRequest(SID)).toBe(T(300));
  });

  it('末尾还没有回复的工具返回不算（可能还在等其他并行工具）；末尾的人工输入算', async () => {
    writeFileSync(file, user(1) + assistant(2) + toolResult(100));
    expect(await tr.peekLastRequest(SID)).toBe(T(1));
    appendFileSync(file, assistant(101) + user(200));
    expect(await tr.peekLastRequest(SID)).toBe(T(200));
  });

  it('API 报错生成的合成 assistant 不算响应', async () => {
    writeFileSync(file, user(1) + assistant(2) + toolResult(100) + JSON.stringify({ type: 'assistant', timestamp: iso(101), isApiErrorMessage: true }) + '\n');
    expect(await tr.peekLastRequest(SID)).toBe(T(1));
  });

  it('没有 user 记录返回 null', async () => {
    writeFileSync(file, assistant(1));
    expect(await tr.peekLastRequest(SID)).toBeNull();
  });

  it('user 记录在很长的行之前，需要向前扩大读取范围', async () => {
    const big = JSON.stringify({ type: 'assistant', timestamp: iso(2), pad: 'x'.repeat(300_000) }) + '\n';
    writeFileSync(file, user(1) + big);
    expect(await tr.peekLastRequest(SID)).toBe(T(1));
  });

  it('文件末尾是写了一半的行时忽略它', async () => {
    writeFileSync(file, user(1) + '{"type":"user","timest');
    expect(await tr.peekLastRequest(SID)).toBe(T(1));
  });

  it('文件增长后返回新的结果', async () => {
    writeFileSync(file, user(1));
    expect(await tr.peekLastRequest(SID)).toBe(T(1));
    appendFileSync(file, user(7));
    expect(await tr.peekLastRequest(SID)).toBe(T(7));
  });
});

describe('FsTranscripts.poll', () => {
  it('第一次建立基线且不返回历史；之后只返回新增', async () => {
    writeFileSync(file, user(1) + user(2));
    const first = await tr.poll(SID);
    expect(first?.lastRequestAt).toBe(Date.parse(iso(2)));
    expect(first?.appended).toEqual([]);

    expect((await tr.poll(SID))?.appended).toEqual([]);
    appendFileSync(file, assistant(3) + user(4, { origin: { kind: 'peer', msg_id: 'm1' } }));
    const next = await tr.poll(SID);
    expect(next?.appended).toHaveLength(1);
    expect(next?.appended[0]).toMatchObject({ originKind: 'peer', originMsgId: 'm1' });
    expect(next?.lastRequestAt).toBe(Date.parse(iso(4)));
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
    expect(r?.lastRequestAt).toBe(Date.parse(iso(2)));
  });

  it('文件被截断后重建基线', async () => {
    writeFileSync(file, user(1) + user(2) + user(3));
    await tr.poll(SID);
    truncateSync(file, 0);
    writeFileSync(file, user(9));
    const r = await tr.poll(SID);
    expect(r?.appended).toEqual([]);
    expect(r?.lastRequestAt).toBe(Date.parse(iso(9)));
  });

  it('找不到记录文件返回 undefined', async () => {
    expect(await tr.poll('nope')).toBeUndefined();
  });
});
