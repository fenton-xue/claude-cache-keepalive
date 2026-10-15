import { describe, expect, it } from 'vitest';
import { parseUserRecord, parseUserRecords } from './transcript';

const line = (o: object) => JSON.stringify(o);
const ts = '2026-10-15T05:21:37.935Z';

describe('parseUserRecord', () => {
  it('人工输入', () => {
    const r = parseUserRecord(line({ type: 'user', timestamp: ts, message: { role: 'user', content: 'hi' }, origin: { kind: 'human' } }));
    expect(r).toEqual({ timestamp: Date.parse(ts), isToolResult: false, isMeta: false, originKind: 'human' });
  });
  it('本程序发送的 peer 消息带 msg_id', () => {
    const r = parseUserRecord(
      line({ type: 'user', timestamp: ts, message: { content: 'x' }, origin: { kind: 'peer', msg_id: 'abc', from: 'uds:/x' }, turnOrigin: 'peer' }),
    );
    expect(r?.originKind).toBe('peer');
    expect(r?.originMsgId).toBe('abc');
  });
  it('工具返回', () => {
    const r = parseUserRecord(line({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }));
    expect(r?.isToolResult).toBe(true);
  });
  it('数组内容但不含 tool_result 不算工具返回', () => {
    const r = parseUserRecord(line({ type: 'user', timestamp: ts, message: { content: [{ type: 'text', text: 'a' }] } }));
    expect(r?.isToolResult).toBe(false);
  });
  it('isMeta 标记', () => {
    expect(parseUserRecord(line({ type: 'user', timestamp: ts, isMeta: true, message: { content: [] } }))?.isMeta).toBe(true);
  });
  it('非 user、侧链、时间戳坏、非 JSON 都返回 null', () => {
    expect(parseUserRecord(line({ type: 'assistant', timestamp: ts }))).toBeNull();
    expect(parseUserRecord(line({ type: 'user', isSidechain: true, timestamp: ts, message: {} }))).toBeNull();
    expect(parseUserRecord(line({ type: 'user', timestamp: 'nope', message: {} }))).toBeNull();
    expect(parseUserRecord(line({ type: 'user', message: {} }))).toBeNull();
    expect(parseUserRecord('{broken')).toBeNull();
    expect(parseUserRecord('null')).toBeNull();
  });
});

describe('parseUserRecords', () => {
  it('跳过空行和其他类型', () => {
    const text = [line({ type: 'user', timestamp: ts, message: {} }), '', line({ type: 'attachment' }), '{bad'].join('\n');
    expect(parseUserRecords(text)).toHaveLength(1);
  });
});
