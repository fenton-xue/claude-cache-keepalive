import { describe, expect, it } from 'vitest';
import { baseName, dirLabels, isWithin, normalizePath, ownerOf, stableOrder, subPath } from './directories';

describe('isWithin / ownerOf', () => {
  it('目录本身和子目录都归属', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b/c/d', '/a/b')).toBe(true);
    expect(isWithin('/a/b/.claude/worktrees/x', '/a/b')).toBe(true);
  });
  it('按路径边界匹配，前缀相同的兄弟目录不算', () => {
    expect(isWithin('/a/bc', '/a/b')).toBe(false);
    expect(isWithin('/a', '/a/b')).toBe(false);
  });
  it('忽略末尾斜杠', () => {
    expect(isWithin('/a/b', '/a/b/')).toBe(true);
    expect(normalizePath('/a/b//')).toBe('/a/b');
    expect(normalizePath('/')).toBe('/');
  });
  it('嵌套时归入最深的目录，与列表顺序无关', () => {
    expect(ownerOf('/a/b/c', ['/a', '/a/b'])).toBe('/a/b');
    expect(ownerOf('/a/b/c', ['/a/b', '/a'])).toBe('/a/b');
    expect(ownerOf('/a/x', ['/a/b', '/a'])).toBe('/a');
  });
  it('不属于任何目录返回 null', () => {
    expect(ownerOf('/z', ['/a', '/a/b'])).toBeNull();
    expect(ownerOf('/z', [])).toBeNull();
  });
});

describe('subPath', () => {
  it('相同为空，worktree 显示相对路径', () => {
    expect(subPath('/a/b', '/a/b')).toBe('');
    expect(subPath('/a/b/.claude/worktrees/ui', '/a/b')).toBe('.claude/worktrees/ui');
    expect(subPath('/a/b/c', '/a/b/')).toBe('c');
  });
});

describe('dirLabels', () => {
  it('只显示最后一级', () => {
    const m = dirLabels(['/x/Documents/Claude', '/x/ones-page']);
    expect(m.get('/x/Documents/Claude')).toBe('Claude');
    expect(m.get('/x/ones-page')).toBe('ones-page');
  });
  it('最后一级同名时两个都追加上一级目录名', () => {
    const m = dirLabels(['/x/Workspace/app', '/x/Codex/app', '/x/other']);
    expect(m.get('/x/Workspace/app')).toBe('app（Workspace）');
    expect(m.get('/x/Codex/app')).toBe('app（Codex）');
    expect(m.get('/x/other')).toBe('other');
  });
  it('根目录', () => {
    expect(baseName('/')).toBe('/');
  });
});

describe('stableOrder', () => {
  const m = (id: string, t: number | null) => ({ id, lastRequestAt: t });
  it('重排：按最后请求时间从新到旧，没有时间的排最后', () => {
    expect(stableOrder(undefined, [m('a', 1), m('b', 3), m('c', null), m('d', 2)], true)).toEqual(['b', 'd', 'a', 'c']);
  });
  it('不重排：保持原顺序，即使时间变了', () => {
    expect(stableOrder(['a', 'b'], [m('a', 1), m('b', 99)], false)).toEqual(['a', 'b']);
  });
  it('不重排：消失的去掉，新出现的按时间从新到旧接在末尾', () => {
    expect(stableOrder(['a', 'b', 'c'], [m('c', 5), m('a', 1), m('x', 2), m('y', 9)], false)).toEqual(['a', 'c', 'y', 'x']);
  });
  it('重排时无视旧顺序', () => {
    expect(stableOrder(['a', 'b'], [m('a', 1), m('b', 2)], true)).toEqual(['b', 'a']);
  });
});
