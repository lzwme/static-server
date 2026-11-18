/**
 * 文件整理接口的集成测试
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { listFacets, listPage, removeDir, startServer, tempDir, upload } = require('./helpers');

/** 调用一个 JSON 接口 */
async function post(base, path_, body) {
  const resp = await fetch(`${base}/localsend/api${path_}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json() };
}

describe('LocalSend 文件整理接口', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = tempDir('sserver-manage-api-');
    server = await startServer(dir);
    base = server.base;
    await upload(base, 'a.txt', 'aaa');
    await upload(base, 'b.txt', 'bbb');
    await upload(base, 'photo.jpg', 'jpg');
    await upload(base, 'sub/c.txt', 'ccc');
  });

  after(async () => {
    if (server) await server.close();
    removeDir(dir);
  });

  it('重命名单个文件', async () => {
    const { status, json } = await post(base, '/rename', { from: 'a.txt', to: 'renamed.txt' });
    assert.equal(status, 200);
    assert.equal(json.code, 0);
    assert.equal(json.data.to, 'renamed.txt');
    assert.equal(fs.existsSync(path.join(dir, 'renamed.txt')), true);
  });

  it('重命名到子目录相当于移动', async () => {
    const { json } = await post(base, '/rename', { from: 'renamed.txt', to: 'sub/moved.txt' });
    assert.equal(json.code, 0);
    assert.equal(json.data.to, 'sub/moved.txt');
    assert.equal(fs.existsSync(path.join(dir, 'sub', 'moved.txt')), true);
  });

  it('重命名不存在的文件返回 400', async () => {
    const { status, json } = await post(base, '/rename', { from: 'nope.txt', to: 'x.txt' });
    assert.equal(status, 400);
    assert.equal(json.code, 1);
  });

  it('批量移动到目录', async () => {
    const { json } = await post(base, '/move', { names: ['b.txt', 'photo.jpg'], dir: '归档' });
    assert.equal(json.code, 0);
    assert.equal(json.data.moved.length, 2);
    assert.equal(json.data.failed.length, 0);
    assert.equal(fs.existsSync(path.join(dir, '归档', 'b.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, '归档', 'photo.jpg')), true);
  });

  it('移动到不存在的目录会自动创建', async () => {
    const { json } = await post(base, '/move', { names: ['归档/b.txt'], dir: '归档/2026' });
    assert.equal(json.code, 0);
    assert.equal(json.data.moved[0].to, '归档/2026/b.txt');
    assert.equal(fs.existsSync(path.join(dir, '归档', '2026', 'b.txt')), true);
  });

  it('批量重命名按规则执行', async () => {
    const { json } = await post(base, '/rename-batch', {
      names: ['归档/2026/b.txt'],
      rule: { mode: 'prefix', prefix: '整理-' },
    });
    assert.equal(json.code, 0);
    assert.equal(json.data.renamed.length, 1);
    assert.equal(json.data.renamed[0].to, '归档/2026/整理-b.txt');
  });

  it('批量重命名按序号执行', async () => {
    const { json } = await post(base, '/rename-batch', {
      names: ['归档/2026/整理-b.txt', '归档/photo.jpg'],
      rule: { mode: 'sequence', padding: 2 },
    });
    assert.equal(json.code, 0);
    assert.equal(json.data.renamed.length, 2);
    assert.equal(json.data.renamed[0].to, '归档/2026/01.txt');
    assert.equal(json.data.renamed[1].to, '归档/02.jpg');
  });

  it('整理后的文件会出现在列表与筛选选项中', async () => {
    const page = await listPage(base, '?q=01.txt');
    assert.equal(page.total, 1);
    assert.equal(page.items[0].name, '归档/2026/01.txt');

    const facets = await listFacets(base);
    const dirs = facets.dirs.map((d) => d.path);
    assert.ok(dirs.includes('归档'));
    assert.ok(dirs.includes('归档/2026'));
  });

  it('整理不会留下临时文件', async () => {
    const leftovers = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{32}$/.test(n));
    assert.deepEqual(leftovers, []);
  });

  it('拒绝越界的移动目标', async () => {
    const { status, json } = await post(base, '/move', { names: ['归档/02.jpg'], dir: '../evil' });
    assert.equal(status, 400);
    assert.equal(json.code, 1);
    assert.equal(fs.existsSync(path.join(dir, '..', 'evil')), false);
  });
});
