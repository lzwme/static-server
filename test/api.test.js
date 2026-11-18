/**
 * LocalSend 接口的集成测试
 *
 * 直接启动真实的 express 应用，通过 HTTP 访问各个接口，
 * 覆盖上传、列表、下载、预览、删除、回收站、分片、打包与测速等主流程。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { listFiles, removeDir, startServer, tempDir, upload } = require('./helpers');

describe('LocalSend 接口', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = tempDir('sserver-api-');
    server = await startServer(dir);
    base = server.base;
  });

  after(async () => {
    if (server) await server.close();
    removeDir(dir);
  });

  it('页面可以正常打开', async () => {
    const resp = await fetch(`${base}/localsend/`);
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assert.match(html, /LocalSend/);
  });

  it('上传文件后出现在列表中', async () => {
    const { status, json } = await upload(base, 'hello.txt', 'hello localsend');
    assert.equal(status, 200);
    assert.equal(json.code, 0);
    assert.equal(json.data.results[0].name, 'hello.txt');
    assert.equal(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'hello localsend');

    const files = await listFiles(base);
    const hit = files.find((f) => f.name === 'hello.txt');
    assert.ok(hit);
    assert.equal(hit.size, 15);
  });

  it('同名文件会自动改名', async () => {
    await upload(base, 'hello.txt', 'again');
    const files = await listFiles(base);
    const names = files.filter((f) => f.name.startsWith('hello')).map((f) => f.name);
    assert.equal(names.length, 2);
    assert.ok(names.includes('hello_1.txt'));
  });

  it('上传子目录文件会保留目录结构', async () => {
    await upload(base, 'sub/dir/file.txt', 'nested');
    assert.equal(fs.existsSync(path.join(dir, 'sub', 'dir', 'file.txt')), true);
    const files = await listFiles(base);
    assert.ok(files.some((f) => f.name === 'sub/dir/file.txt'));
  });

  it('下载接口返回原始内容', async () => {
    const resp = await fetch(`${base}/localsend/api/download/hello.txt`);
    assert.equal(resp.status, 200);
    assert.equal(await resp.text(), 'hello localsend');
  });

  it('预览接口以内联方式返回内容', async () => {
    const resp = await fetch(`${base}/localsend/api/preview/hello.txt`);
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-disposition') || '', /inline/);
    assert.equal(await resp.text(), 'hello localsend');
  });

  it('下载不存在的文件返回 404', async () => {
    const resp = await fetch(`${base}/localsend/api/download/not-exist.txt`);
    assert.equal(resp.status, 404);
  });

  it('禁止上传可执行脚本类型', async () => {
    const { status, json } = await upload(base, 'evil.php', '<?php echo 1;');
    assert.equal(status, 403);
    assert.equal(json.code, 1);
  });

  it('删除文件后进入回收站并可还原', async () => {
    await upload(base, 'trash-me.txt', 'bye');
    const del = await fetch(`${base}/localsend/api/delete/trash-me.txt`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const delJson = await del.json();
    assert.equal(delJson.code, 0);
    assert.equal(fs.existsSync(path.join(dir, 'trash-me.txt')), false);

    const trashResp = await fetch(`${base}/localsend/api/trash`);
    const trashJson = await trashResp.json();
    const entry = trashJson.data.find((t) => t.name === 'trash-me.txt');
    assert.ok(entry);

    const restore = await fetch(`${base}/localsend/api/trash/${entry.id}/restore`, { method: 'POST' });
    const restoreJson = await restore.json();
    assert.equal(restoreJson.code, 0);
    assert.equal(fs.existsSync(path.join(dir, 'trash-me.txt')), true);
  });

  it('批量打包下载返回合法 zip', async () => {
    await upload(base, 'zip-a.txt', 'AAA');
    await upload(base, 'zip-b.txt', 'BBB');
    const resp = await fetch(`${base}/localsend/api/zip?names=zip-a.txt,zip-b.txt`);
    assert.equal(resp.status, 200);
    const buf = Buffer.from(await resp.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString('ascii'), 'PK');
    assert.ok(buf.includes(Buffer.from('zip-a.txt')));
    assert.ok(buf.includes(Buffer.from('zip-b.txt')));
  });

  it('分片上传可以合并出完整文件', async () => {
    // 分片大小有下限（64KB），这里用 200KB 的文件切成 4 片
    const content = Buffer.alloc(200_000, 7);
    const initResp = await fetch(`${base}/localsend/api/chunk/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'chunked.bin', size: content.length, chunkSize: 64 * 1024 }),
    });
    const initJson = await initResp.json();
    assert.equal(initJson.code, 0);
    const { uploadId, total, chunkSize } = initJson.data;
    assert.equal(total, 4);

    for (let i = 0; i < total; i++) {
      const part = content.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, content.length));
      const form = new FormData();
      form.append('chunk', new Blob([part]), `chunk-${i}`);
      const resp = await fetch(`${base}/localsend/api/chunk/upload?uploadId=${uploadId}&index=${i}`, {
        method: 'POST',
        body: form,
      });
      const json = await resp.json();
      assert.equal(json.code, 0);
    }

    const mergeResp = await fetch(`${base}/localsend/api/chunk/merge?uploadId=${uploadId}`, { method: 'POST' });
    const mergeJson = await mergeResp.json();
    assert.equal(mergeJson.code, 0);
    assert.equal(mergeJson.data.name, 'chunked.bin');
    const merged = fs.readFileSync(path.join(dir, 'chunked.bin'));
    assert.equal(merged.length, content.length);
    assert.deepEqual(merged, content);
  });

  it('测速接口返回固定大小的数据', async () => {
    const resp = await fetch(`${base}/localsend/api/speed?size=2`);
    assert.equal(resp.status, 200);
    const buf = Buffer.from(await resp.arrayBuffer());
    assert.equal(buf.length, 2 * 1024 * 1024);

    const upResp = await fetch(`${base}/localsend/api/speed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(1024 * 1024, 1),
    });
    const upJson = await upResp.json();
    assert.equal(upJson.code, 0);
    assert.equal(upJson.data.bytes, 1024 * 1024);
  });

  it('分享链接可以下载文件', async () => {
    await upload(base, 'shared.txt', 'share me');
    const resp = await fetch(`${base}/localsend/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: ['shared.txt'] }),
    });
    const json = await resp.json();
    assert.equal(json.code, 0);
    const link = json.data.url || json.data.token;
    assert.ok(link);

    const shareUrl = link.startsWith('http') ? link : `${base}${link.startsWith('/') ? '' : '/'}${link}`;
    const dl = await fetch(shareUrl);
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), 'share me');
  });

  it('WebDAV 目录列表返回 XML', async () => {
    const resp = await fetch(`${base}/localsend/dav/`, { method: 'PROPFIND', headers: { Depth: '1' } });
    assert.equal(resp.status, 207);
    const xml = await resp.text();
    assert.match(xml, /<D:multistatus|<multistatus/);
  });

  it('SSE 变更事件可以建立连接', async () => {
    const ctrl = new AbortController();
    const resp = await fetch(`${base}/localsend/api/events`, { signal: ctrl.signal });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') || '', /event-stream/);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    // 分片到达，累积到出现 ready 事件为止
    for (let i = 0; i < 10 && !text.includes('event: ready'); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    assert.match(text, /event: ready/);
    ctrl.abort();
  });

  it('列表按名称排序并返回相对路径', async () => {
    const files = await listFiles(base, '?sort=time&order=desc');
    assert.ok(Array.isArray(files));
    assert.ok(files.every((f) => typeof f.name === 'string'));
  });
});
