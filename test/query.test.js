/**
 * 列表查询解析、过滤、排序与分页的单元测试
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ROOT_DIR,
  collectDirs,
  collectExts,
  dirOfName,
  filterEntries,
  paginate,
  parseListQuery,
  sortEntries,
} = require('../dist/localsend/query');

/** 构造一个文件条目 */
function file(name, size = 100, mtime = 1000) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return { name, size, mtime, ext, isDir: false };
}

describe('parseListQuery', () => {
  it('缺省参数走默认排序与分页', () => {
    const q = parseListQuery({});
    assert.equal(q.sort, 'time');
    assert.equal(q.asc, false);
    assert.equal(q.page, 1);
    assert.equal(q.pageSize, DEFAULT_PAGE_SIZE);
    assert.equal(q.q, '');
    assert.equal(q.dir, '');
    assert.equal(q.ext, '');
    assert.equal(q.since, 0);
  });

  it('解析排序、搜索与筛选条件', () => {
    const q = parseListQuery({ sort: 'size', order: 'asc', page: '3', pageSize: '20', q: '  Report ', dir: 'sub', ext: '.PDF', since: '1700000000000' });
    assert.equal(q.sort, 'size');
    assert.equal(q.asc, true);
    assert.equal(q.page, 3);
    assert.equal(q.pageSize, 20);
    assert.equal(q.q, 'report');
    assert.equal(q.dir, 'sub');
    assert.equal(q.ext, 'pdf');
    assert.equal(q.since, 1700000000000);
  });

  it('支持按名称排序', () => {
    assert.equal(parseListQuery({ sort: 'name' }).sort, 'name');
    assert.equal(parseListQuery({ sort: 'name', order: 'asc' }).asc, true);
  });

  it('非法参数回退到默认值', () => {
    const q = parseListQuery({ page: 'abc', pageSize: '-5', since: 'x', sort: 'unknown' });
    assert.equal(q.page, 1);
    assert.equal(q.pageSize, DEFAULT_PAGE_SIZE);
    assert.equal(q.since, 0);
    assert.equal(q.sort, 'time');
  });

  it('每页条数有上限，避免一次返回过多数据', () => {
    assert.equal(parseListQuery({ pageSize: '100000' }).pageSize, MAX_PAGE_SIZE);
  });
});

describe('filterEntries', () => {
  const entries = [file('a.txt'), file('sub/b.txt'), file('sub/deep/c.PDF', 200, 5000), file('other/d.png', 300, 9000)];

  it('按关键词匹配相对路径且不区分大小写', () => {
    const q = parseListQuery({ q: 'SUB' });
    const hit = filterEntries(entries, q).map((e) => e.name);
    assert.deepEqual(hit.sort(), ['sub/b.txt', 'sub/deep/c.PDF']);
  });

  it('按目录精确筛选（只匹配直接父目录）', () => {
    const q = parseListQuery({ dir: 'sub' });
    assert.deepEqual(filterEntries(entries, q).map((e) => e.name), ['sub/b.txt']);
    // 更深一层的目录需要单独筛选
    const deep = parseListQuery({ dir: 'sub/deep' });
    assert.deepEqual(filterEntries(entries, deep).map((e) => e.name), ['sub/deep/c.PDF']);
  });

  it('根目录筛选只保留顶层文件', () => {
    const q = parseListQuery({ dir: ROOT_DIR });
    assert.deepEqual(filterEntries(entries, q).map((e) => e.name), ['a.txt']);
  });

  it('按扩展名与时间窗筛选', () => {
    assert.deepEqual(filterEntries(entries, parseListQuery({ ext: 'pdf' })).map((e) => e.name), ['sub/deep/c.PDF']);
    assert.deepEqual(filterEntries(entries, parseListQuery({ since: '6000' })).map((e) => e.name), ['other/d.png']);
  });

  it('无筛选条件时返回全部', () => {
    assert.equal(filterEntries(entries, parseListQuery({})).length, entries.length);
  });
});

describe('sortEntries', () => {
  const entries = [file('b.txt', 300, 1000), file('a.txt', 100, 3000), file('c.txt', 200, 2000)];

  it('按大小排序', () => {
    assert.deepEqual(sortEntries(entries, 'size', true).map((e) => e.name), ['a.txt', 'c.txt', 'b.txt']);
    assert.deepEqual(sortEntries(entries, 'size', false).map((e) => e.name), ['b.txt', 'c.txt', 'a.txt']);
  });

  it('按时间排序', () => {
    assert.deepEqual(sortEntries(entries, 'time', true).map((e) => e.name), ['b.txt', 'c.txt', 'a.txt']);
  });

  it('主字段相同时按名称兜底，保证翻页顺序稳定', () => {
    const same = [file('z.txt', 100, 1000), file('a.txt', 100, 1000)];
    assert.deepEqual(sortEntries(same, 'time', true).map((e) => e.name), ['a.txt', 'z.txt']);
  });

  it('按名称排序', () => {
    const named = [file('c.txt'), file('a.txt'), file('b.txt')];
    assert.deepEqual(sortEntries(named, 'name', true).map((e) => e.name), ['a.txt', 'b.txt', 'c.txt']);
    assert.deepEqual(sortEntries(named, 'name', false).map((e) => e.name), ['c.txt', 'b.txt', 'a.txt']);
  });

  it('名称排序按拼音排列中文，数值部分按大小比较而不是逐字符', () => {
    const zh = [file('张.txt'), file('李.txt'), file('文件10.txt'), file('文件2.txt')];
    assert.deepEqual(sortEntries(zh, 'name', true).map((e) => e.name), ['李.txt', '文件2.txt', '文件10.txt', '张.txt']);
  });

  it('不会污染原数组', () => {
    const copy = entries.slice();
    sortEntries(entries, 'size', true);
    assert.deepEqual(entries, copy);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 25 }, (_, i) => file(`f${i}.txt`));

  it('切出当前页并给出总数与总页数', () => {
    const r = paginate(items, 2, 10);
    assert.equal(r.total, 25);
    assert.equal(r.totalPages, 3);
    assert.equal(r.page, 2);
    assert.equal(r.items.length, 10);
    assert.equal(r.items[0].name, 'f10.txt');
  });

  it('最后一页条目数可以不足一页', () => {
    const r = paginate(items, 3, 10);
    assert.equal(r.items.length, 5);
  });

  it('页码越界时收敛到有效范围', () => {
    assert.equal(paginate(items, 99, 10).page, 3);
    assert.equal(paginate(items, 0, 10).page, 1);
  });

  it('空列表时总页数为 1', () => {
    const r = paginate([], 1, 10);
    assert.equal(r.total, 0);
    assert.equal(r.totalPages, 1);
    assert.deepEqual(r.items, []);
  });
});

describe('筛选选项统计', () => {
  const entries = [file('a.txt'), file('b.pdf'), file('sub/c.txt'), file('sub/d.pdf'), file('other/e.txt')];

  it('统计目录与根目录条目数', () => {
    const { dirs, rootCount } = collectDirs(entries);
    assert.equal(rootCount, 2);
    assert.deepEqual(dirs, [
      { path: 'other', count: 1 },
      { path: 'sub', count: 2 },
    ]);
  });

  it('统计扩展名并按数量排序', () => {
    assert.deepEqual(collectExts(entries), [
      { ext: 'txt', count: 3 },
      { ext: 'pdf', count: 2 },
    ]);
  });

  it('取文件所在目录', () => {
    assert.equal(dirOfName('a.txt'), '');
    assert.equal(dirOfName('sub/a.txt'), 'sub');
    assert.equal(dirOfName('sub/deep/a.txt'), 'sub/deep');
  });
});
