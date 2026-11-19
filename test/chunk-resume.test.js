/**
 * 分片上传的断点续传
 *
 * 语义约定：
 *  - init 带 uploadId 或 fileKey 时，复用同名同大小的任务，返回已上传分片
 *  - 元信息落盘，服务重启后仍能接上（分片以磁盘实际文件为准）
 *  - 没有任何分片的旧任务不被复用，避免客户端拿着死 ID 反复重试
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { createChunkStore } = require('../dist/localsend/chunk');
const { tempDir, removeDir } = require('./helpers');

/** 建一个临时存储目录 */
function setup(prefix) {
  const dir = tempDir(prefix);
  const tmpDir = path.join(dir, '.chunks');
  fs.mkdirSync(tmpDir, { recursive: true });
  return { dir, tmpDir };
}

/** 写入第 index 个分片（模拟 multer 落下的临时文件） */
function writePart(store, tmpDir, uploadId, index, size) {
  const temp = path.join(tmpDir, `incoming-${uploadId}-${index}`);
  fs.writeFileSync(temp, Buffer.alloc(size, index + 1));
  return store.writeChunk(uploadId, index, temp);
}

describe('分片断点续传', () => {
  it('带 fileKey 重复 init 会复用同一任务', () => {
    const { dir, tmpDir } = setup('ls-resume-key-');
    const store = createChunkStore({ dir, tmpDir, ttl: 60_000 });
    try {
      const fileKey = 'movie.bin:1024:1700000000000';
      const first = store.init('movie.bin', 1024, 512, { fileKey });
      writePart(store, tmpDir, first.uploadId, 0, 512);
      const second = store.init('movie.bin', 1024, 512, { fileKey });
      assert.equal(second.uploadId, first.uploadId);
      assert.equal(second.resumed, true);
      assert.deepEqual(second.received, [0]);
      assert.equal(second.total, 2);
    } finally {
      store.stop();
      removeDir(dir);
    }
  });

  it('带 uploadId 可续传，并跳过已传分片', () => {
    const { dir, tmpDir } = setup('ls-resume-id-');
    const store = createChunkStore({ dir, tmpDir, ttl: 60_000 });
    try {
      const first = store.init('big.bin', 1200, 400);
      writePart(store, tmpDir, first.uploadId, 1, 400);
      const again = store.init('big.bin', 1200, 400, { uploadId: first.uploadId });
      assert.equal(again.uploadId, first.uploadId);
      assert.deepEqual(again.received, [1]);
    } finally {
      store.stop();
      removeDir(dir);
    }
  });

  it('同名但大小不同不复用', () => {
    const { dir, tmpDir } = setup('ls-resume-mismatch-');
    const store = createChunkStore({ dir, tmpDir, ttl: 60_000 });
    try {
      const fileKey = 'same.bin:1000:1';
      const first = store.init('same.bin', 1000, 500, { fileKey });
      writePart(store, tmpDir, first.uploadId, 0, 500);
      const other = store.init('same.bin', 2000, 500, { fileKey });
      assert.notEqual(other.uploadId, first.uploadId);
      assert.equal(other.resumed, false);
    } finally {
      store.stop();
      removeDir(dir);
    }
  });

  it('服务重启后仍可按 uploadId / fileKey 接上', () => {
    const { dir, tmpDir } = setup('ls-resume-restart-');
    const fileKey = 'restart.bin:2048:99';
    let uploadId = '';
    const before = createChunkStore({ dir, tmpDir, ttl: 60_000 });
    try {
      const started = before.init('restart.bin', 2048, 1024, { fileKey });
      uploadId = started.uploadId;
      writePart(before, tmpDir, uploadId, 0, 1024);
    } finally {
      // 直接停掉，模拟进程退出（内存里的任务全部丢失）
      before.stop();
    }

    const after = createChunkStore({ dir, tmpDir, ttl: 60_000 });
    try {
      // 1) 按 uploadId 找回
      const status = after.status(uploadId);
      assert.ok(status, '重启后应能从磁盘恢复任务');
      assert.deepEqual(status.received, [0]);
      assert.equal(status.complete, false);

      // 2) 按 fileKey 找回
      const resumed = after.init('restart.bin', 2048, 1024, { fileKey });
      assert.equal(resumed.uploadId, uploadId);
      assert.equal(resumed.resumed, true);
      assert.deepEqual(resumed.received, [0]);
    } finally {
      after.stop();
      removeDir(dir);
    }
  });

  it('没有任何分片的旧任务不被复用', () => {
    const { dir, tmpDir } = setup('ls-resume-empty-');
    const store = createChunkStore({ dir, tmpDir, ttl: 60_000 });
    try {
      const fileKey = 'empty.bin:1024:1';
      const first = store.init('empty.bin', 1024, 512, { fileKey });
      // 分片被别人清掉了（例如服务端清理、手工删除）
      fs.rmSync(path.join(tmpDir, `${first.uploadId}.json`), { force: true });
      const second = store.init('empty.bin', 1024, 512, { fileKey });
      assert.notEqual(second.uploadId, first.uploadId);
      assert.equal(second.resumed, false);
    } finally {
      store.stop();
      removeDir(dir);
    }
  });

  it('合并完成后任务与元信息一并清理', () => {
    const { dir, tmpDir } = setup('ls-resume-merge-');
    const store = createChunkStore({ dir, tmpDir, ttl: 60_000 });
    try {
      const started = store.init('done.bin', 1024, 512);
      writePart(store, tmpDir, started.uploadId, 0, 512);
      writePart(store, tmpDir, started.uploadId, 1, 512);
      const target = path.join(dir, 'done.bin');
      const merged = store.merge(started.uploadId, () => ({ path: target, name: 'done.bin' }));
      assert.ok(merged);
      assert.equal(fs.statSync(target).size, 1024);
      assert.equal(store.meta(started.uploadId), undefined);
      assert.equal(fs.existsSync(path.join(tmpDir, `${started.uploadId}.json`)), false);
    } finally {
      store.stop();
      removeDir(dir);
    }
  });
});
