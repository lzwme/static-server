/**
 * 列表缓存的目录监听
 *
 * 以前只监听根目录与一级子目录，深层子目录里的新增文件不会被推送，
 * 要等 5 分钟 TTL 过期才在列表里出现。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { createListCache } = require('../dist/localsend/cache');
const { tempDir, removeDir } = require('./helpers');

/** 轮询等待条件成立 */
async function waitFor(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return false;
}

describe('目录监听的深度', () => {
  it('三层子目录里的新增文件也会触发推送', async () => {
    const dir = tempDir('ls-watch-deep-');
    fs.mkdirSync(path.join(dir, '归档', '2026', '项目'), { recursive: true });
    const changes = [];
    const cache = createListCache({ dir, ttl: 60_000, onChange: (names) => changes.push(...names) });
    cache.startWatch();
    try {
      cache.list(); // 首次扫描，建立基线
      fs.writeFileSync(path.join(dir, '归档', '2026', '项目', 'deep.txt'), 'x');
      const received = await waitFor(() => changes.includes('归档/2026/项目/deep.txt'));
      assert.ok(received, `未收到深层变更，已收到：${changes.join(', ') || '（无）'}`);
      // 缓存本身也要能立刻看到这个文件
      const names = cache.list().map((item) => item.name);
      assert.ok(names.includes('归档/2026/项目/deep.txt'));
    } finally {
      cache.stop();
      removeDir(dir);
    }
  });

  it('普通子目录的新增同样可感知', async () => {
    const dir = tempDir('ls-watch-sub-');
    fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
    const changes = [];
    const cache = createListCache({ dir, ttl: 60_000, onChange: (names) => changes.push(...names) });
    cache.startWatch();
    try {
      cache.list();
      fs.writeFileSync(path.join(dir, 'inbox', 'a.txt'), 'a');
      const received = await waitFor(() => changes.includes('inbox/a.txt'));
      assert.ok(received, `未收到变更：${changes.join(', ') || '（无）'}`);
    } finally {
      cache.stop();
      removeDir(dir);
    }
  });

  it('停止监听后不再推送', async () => {
    const dir = tempDir('ls-watch-stop-');
    const changes = [];
    const cache = createListCache({ dir, ttl: 60_000, onChange: (names) => changes.push(...names) });
    cache.startWatch();
    cache.list();
    cache.stop();
    fs.writeFileSync(path.join(dir, 'after-stop.txt'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(changes.includes('after-stop.txt'), false);
    removeDir(dir);
  });
});
