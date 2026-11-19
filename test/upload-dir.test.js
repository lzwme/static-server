/**
 * 上传目标目录
 *
 * 以前上传一律落根目录，用户在某个目录视图里上传完还得再移动一次。
 * 现在 `?dir=` 指定目标目录，上传文件夹时在此基础上保留原有结构。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { startServer, tempDir, removeDir, upload } = require('./helpers');

describe('上传到指定目录', () => {
  it('文件落在指定目录，并在该目录下保留子路径', async () => {
    const dir = tempDir('ls-upload-dir-');
    const server = await startServer(dir, {});
    try {
      const query = `?dir=${encodeURIComponent('归档/2026')}`;
      const one = await upload(server.base, 'a.txt', 'hello', query);
      assert.equal(one.status, 200);
      assert.equal(one.json.data.results[0].name, '归档/2026/a.txt');
      assert.equal(fs.readFileSync(path.join(dir, '归档', '2026', 'a.txt'), 'utf8'), 'hello');

      // 上传文件夹：目录前缀 + 文件夹内部结构
      const nested = await upload(server.base, '照片/1.jpg', 'jpg', query);
      assert.equal(nested.status, 200);
      assert.equal(nested.json.data.results[0].name, '归档/2026/照片/1.jpg');
      assert.ok(fs.existsSync(path.join(dir, '归档', '2026', '照片', '1.jpg')));
    } finally {
      await server.close();
      removeDir(dir);
    }
  });

  it('同名文件在目标目录内自动改名，不影响根目录同名文件', async () => {
    const dir = tempDir('ls-upload-dir-dup-');
    const server = await startServer(dir, {});
    try {
      await upload(server.base, 'note.txt', 'root', '');
      const inDir = await upload(server.base, 'note.txt', 'sub', `?dir=${encodeURIComponent('docs')}`);
      assert.equal(inDir.json.data.results[0].name, 'docs/note.txt');
      const again = await upload(server.base, 'note.txt', 'sub2', `?dir=${encodeURIComponent('docs')}`);
      assert.equal(again.json.data.results[0].name, 'docs/note_1.txt');
      assert.equal(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8'), 'root');
    } finally {
      await server.close();
      removeDir(dir);
    }
  });

  it('非法的目标目录直接拒绝，不会静默落到根目录', async () => {
    const dir = tempDir('ls-upload-dir-bad-');
    const server = await startServer(dir, {});
    try {
      const resp = await upload(server.base, 'x.txt', 'x', `?dir=${encodeURIComponent('../escape')}`);
      assert.equal(resp.status, 400);
      assert.equal(fs.existsSync(path.join(dir, 'x.txt')), false);
      assert.equal(fs.existsSync(path.join(path.dirname(dir), 'escape', 'x.txt')), false);
    } finally {
      await server.close();
      removeDir(dir);
    }
  });

  it('分片合并同样落在指定目录', async () => {
    const dir = tempDir('ls-upload-dir-chunk-');
    const server = await startServer(dir, {});
    try {
      const name = '归档/big.bin';
      const chunkSize = 64 * 1024;
      const size = chunkSize * 2;
      const init = await fetch(`${server.base}/localsend/api/chunk/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, size, chunkSize }),
      }).then((r) => r.json());
      assert.equal(init.code, 0);

      for (let i = 0; i < 2; i++) {
        const fd = new FormData();
        fd.append('chunk', new Blob([Buffer.alloc(chunkSize, i + 1)]), `chunk-${i}`);
        const resp = await fetch(`${server.base}/localsend/api/chunk/upload?uploadId=${init.data.uploadId}&index=${i}`, {
          method: 'POST',
          body: fd,
        });
        assert.equal(resp.status, 200);
      }
      const merged = await fetch(`${server.base}/localsend/api/chunk/merge?uploadId=${init.data.uploadId}`, { method: 'POST' }).then((r) =>
        r.json(),
      );
      assert.equal(merged.code, 0);
      assert.equal(merged.data.name, '归档/big.bin');
      assert.equal(fs.statSync(path.join(dir, '归档', 'big.bin')).size, size);
    } finally {
      await server.close();
      removeDir(dir);
    }
  });
});
