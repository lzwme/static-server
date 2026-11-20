/**
 * 文件列表分页与搜索的集成测试
 *
 * 用独立的存储目录，避免与其它用例的文件互相干扰。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { listFacets, listPage, removeDir, startServer, tempDir, upload } = require('./helpers');

describe('LocalSend 列表分页与搜索', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = tempDir('sserver-page-');
    server = await startServer(dir);
    base = server.base;
    // 12 个根目录文件 + 3 个子目录文件 + 1 个图片
    for (let i = 1; i <= 12; i++) {
      const name = `page-${String(i).padStart(2, '0')}.txt`;
      await upload(base, name, `content ${i}`);
    }
    await upload(base, 'sub/nested-1.txt', 'nested');
    await upload(base, 'sub/nested-2.txt', 'nested');
    await upload(base, 'sub/deep/deep-1.txt', 'deep');
    await upload(base, 'picture.png', 'not really a png');
  });

  after(async () => {
    if (server) await server.close();
    removeDir(dir);
  });

  it('返回分页信息而不是完整数组', async () => {
    const data = await listPage(base);
    assert.equal(typeof data.total, 'number');
    assert.equal(typeof data.page, 'number');
    assert.equal(typeof data.pageSize, 'number');
    assert.equal(typeof data.totalPages, 'number');
    assert.ok(Array.isArray(data.items));
    assert.equal(data.total, 16);
    assert.equal(data.allTotal, 16);
  });

  it('按每页条数切分数据', async () => {
    const first = await listPage(base, '?page=1&pageSize=5&sort=time&order=asc');
    assert.equal(first.items.length, 5);
    assert.equal(first.pageSize, 5);
    assert.equal(first.totalPages, 4);
    assert.equal(first.page, 1);

    const last = await listPage(base, '?page=4&pageSize=5&sort=time&order=asc');
    assert.equal(last.items.length, 1);
    assert.equal(last.page, 4);
  });

  it('不同页返回不同文件', async () => {
    const p1 = await listPage(base, '?page=1&pageSize=5&sort=time&order=asc');
    const p2 = await listPage(base, '?page=2&pageSize=5&sort=time&order=asc');
    const names = [...p1.items, ...p2.items].map((f) => f.name);
    assert.equal(new Set(names).size, names.length);
  });

  it('页码越界时收敛到最后一页', async () => {
    const data = await listPage(base, '?page=999&pageSize=5');
    assert.equal(data.page, data.totalPages);
  });

  it('按关键词搜索匹配相对路径', async () => {
    const data = await listPage(base, '?q=nested');
    assert.equal(data.total, 2);
    assert.ok(data.items.every((f) => f.name.includes('nested')));
  });

  it('搜索不区分大小写', async () => {
    const data = await listPage(base, '?q=NESTED');
    assert.equal(data.total, 2);
  });

  it('按目录筛选只返回该目录下的文件', async () => {
    const data = await listPage(base, '?dir=sub');
    assert.equal(data.total, 2);
    assert.ok(data.items.every((f) => f.name.startsWith('sub/')));
  });

  it('按根目录筛选只返回顶层文件', async () => {
    const data = await listPage(base, '?dir=__root__');
    assert.equal(data.total, 13);
    assert.ok(data.items.every((f) => !f.name.includes('/')));
  });

  it('按扩展名筛选', async () => {
    const data = await listPage(base, '?ext=png');
    assert.equal(data.total, 1);
    assert.equal(data.items[0].name, 'picture.png');
  });

  it('搜索与分页可以叠加使用', async () => {
    const data = await listPage(base, '?q=page&pageSize=5&page=2');
    assert.equal(data.total, 12);
    assert.equal(data.items.length, 5);
  });

  it('筛选选项接口返回目录与扩展名统计', async () => {
    const facets = await listFacets(base);
    assert.equal(facets.total, 16);
    assert.equal(facets.rootCount, 13);
    const dirs = facets.dirs.map((d) => d.path);
    assert.ok(dirs.includes('sub'));
    assert.ok(dirs.includes('sub/deep'));
    const sub = facets.dirs.find((d) => d.path === 'sub');
    assert.equal(sub.count, 2);
    const txt = facets.exts.find((e) => e.ext === 'txt');
    assert.equal(txt.count, 15);
  });

  it('支持按名称排序', async () => {
    const asc = await listPage(base, '?pageSize=500&sort=name&order=asc');
    const expected = [
      ...Array.from({ length: 12 }, (_, i) => `page-${String(i + 1).padStart(2, '0')}.txt`),
      'picture.png',
      'sub/deep/deep-1.txt',
      'sub/nested-1.txt',
      'sub/nested-2.txt',
    ];
    assert.deepEqual(
      asc.items.map((f) => f.name),
      expected,
    );
    const desc = await listPage(base, '?pageSize=500&sort=name&order=desc');
    assert.deepEqual(
      desc.items.map((f) => f.name),
      expected.slice().reverse(),
    );
  });

  it('上传新文件后总数随之增加', async () => {
    await upload(base, 'fresh.txt', 'fresh');
    const data = await listPage(base, '?q=fresh');
    assert.equal(data.total, 1);
    assert.equal(fs.existsSync(path.join(dir, 'fresh.txt')), true);
  });
});
