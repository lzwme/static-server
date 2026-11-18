/**
 * 分片上传暂存区的单元测试
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { removeDir, tempDir } = require('./helpers');

const { createChunkStore } = require('../dist/lib/localsend-chunk');

describe('分片暂存区', () => {
  let dir;
  let tmpDir;
  let store;

  before(() => {
    dir = tempDir('sserver-chunk-dir-');
    tmpDir = path.join(dir, '.chunks');
    fs.mkdirSync(tmpDir, { recursive: true });
    store = createChunkStore({ dir, tmpDir, ttl: 60_000, maxSize: 1024 * 1024 });
  });

  after(() => {
    removeDir(dir);
  });

  it('初始化返回分片数量与分片大小', () => {
    const result = store.init('big.bin', 1000, 400);
    assert.ok(result.uploadId);
    assert.equal(result.total, 3);
    assert.equal(result.chunkSize, 400);
    assert.deepEqual(result.received, []);
  });

  it('分片数量受上限约束', () => {
    assert.throws(() => store.init('too-many.bin', 10 * 1024 * 1024, 1024));
  });

  it('写入分片后可查询状态', () => {
    const { uploadId, total, chunkSize } = store.init('part.bin', 1000, 400);
    const chunkPath = path.join(tmpDir, 'part-0');
    fs.writeFileSync(chunkPath, Buffer.alloc(chunkSize, 1));
    const written = store.writeChunk(uploadId, 0, chunkPath);
    assert.equal(written.index, 0);
    assert.equal(written.total, total);
    assert.deepEqual(written.received, [0]);

    const status = store.status(uploadId);
    assert.equal(status.complete, false);
    assert.deepEqual(status.received, [0]);
  });

  it('越界的分片序号会被拒绝', () => {
    const { uploadId, total } = store.init('bad.bin', 1000, 400);
    const chunkPath = path.join(tmpDir, 'bad-0');
    fs.writeFileSync(chunkPath, Buffer.alloc(10, 1));
    assert.equal(store.writeChunk(uploadId, total, chunkPath), null);
    assert.equal(store.writeChunk(uploadId, -1, chunkPath), null);
  });

  it('分片不完整时无法合并', () => {
    const { uploadId, chunkSize } = store.init('incomplete.bin', 1000, 400);
    const chunkPath = path.join(tmpDir, 'incomplete-0');
    fs.writeFileSync(chunkPath, Buffer.alloc(chunkSize, 2));
    store.writeChunk(uploadId, 0, chunkPath);
    const result = store.merge(uploadId, (name) => ({ path: path.join(dir, name), name }));
    assert.equal(result, null);
  });

  it('分片齐全后合并出完整文件', () => {
    const { uploadId, chunkSize, total } = store.init('merged.bin', 1000, 400);
    const parts = [];
    for (let i = 0; i < total; i++) {
      const size = i === total - 1 ? 1000 - chunkSize * (total - 1) : chunkSize;
      const chunkPath = path.join(tmpDir, `merged-${i}`);
      const buf = Buffer.alloc(size, i + 1);
      fs.writeFileSync(chunkPath, buf);
      parts.push(buf);
      store.writeChunk(uploadId, i, chunkPath);
    }
    const result = store.merge(uploadId, (name) => ({ path: path.join(dir, name), name }));
    assert.ok(result);
    assert.equal(result.size, 1000);
    const merged = fs.readFileSync(path.join(dir, result.name));
    assert.equal(merged.length, 1000);
    assert.deepEqual(merged, Buffer.concat(parts));
  });

  it('取消任务会清理暂存分片', () => {
    const { uploadId, chunkSize } = store.init('cancel.bin', 400, 400);
    const chunkPath = path.join(tmpDir, 'cancel-0');
    fs.writeFileSync(chunkPath, Buffer.alloc(chunkSize, 3));
    store.writeChunk(uploadId, 0, chunkPath);
    assert.equal(store.cancel(uploadId), true);
    assert.equal(store.meta(uploadId), undefined);
  });
});
