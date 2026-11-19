/**
 * 存储配额与用量
 *
 * 之前 dirSize 只统计根目录文件，上传文件夹（保留目录结构）可以无限绕过
 * maxTotalSize；页面也看不到「已用多少、还剩多少」。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { startServer, tempDir, removeDir, upload } = require('./helpers');

/** 递归统计（含子目录），用于和服务的口径对照 */
function sizeOf(dir) {
  let total = 0;
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      if (name === '.chunks' || name === '.trash') continue;
      const full = path.join(current, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else total += st.size;
    }
  };
  walk(dir);
  return total;
}

const KB = 1024;

describe('存储配额', () => {
  it('子目录里的文件同样计入配额，超出时拒绝', async () => {
    const dir = tempDir('ls-quota-');
    const limit = 300 * KB;
    const server = await startServer(dir, { maxTotalSize: limit });
    try {
      const root = await upload(server.base, 'root-200k.bin', Buffer.alloc(200 * KB));
      assert.equal(root.status, 200);

      // 子目录里再放 200KB：总占用会到 400KB，必须拒绝
      const sub = await upload(server.base, 'sub/inner-200k.bin', Buffer.alloc(200 * KB));
      assert.equal(sub.status, 413, '子目录上传应因超出配额被拒绝');
      assert.ok(sizeOf(dir) <= limit, `实际占用 ${sizeOf(dir)} 不应超过 ${limit}`);
    } finally {
      await server.close();
      removeDir(dir);
    }
  });

  it('连续往子目录追加也不会绕过上限', async () => {
    const dir = tempDir('ls-quota-loop-');
    const limit = 300 * KB;
    const server = await startServer(dir, { maxTotalSize: limit });
    try {
      assert.equal((await upload(server.base, 'root-200k.bin', Buffer.alloc(200 * KB))).status, 200);
      let ok = 0;
      let rejected = 0;
      for (let i = 0; i < 10; i++) {
        const resp = await upload(server.base, `sub/f-${i}-50k.bin`, Buffer.alloc(50 * KB));
        if (resp.status === 200) ok += 1;
        else rejected += 1;
      }
      assert.ok(rejected > 0, '应至少有部分上传被拒绝');
      assert.ok(sizeOf(dir) <= limit, `实际占用 ${sizeOf(dir)} 不应超过 ${limit}（成功 ${ok} 个）`);
    } finally {
      await server.close();
      removeDir(dir);
    }
  });
});

describe('用量接口', () => {
  it('返回已用、上限、回收站占用', async () => {
    const dir = tempDir('ls-usage-');
    const limit = 10 * 1024 * KB;
    const server = await startServer(dir, { maxTotalSize: limit });
    try {
      await upload(server.base, 'a.bin', Buffer.alloc(100 * KB));
      await upload(server.base, 'sub/b.bin', Buffer.alloc(50 * KB));

      const first = await fetch(`${server.base}/localsend/api/usage`).then((r) => r.json());
      assert.equal(first.code, 0);
      assert.equal(first.data.used, 150 * KB);
      assert.equal(first.data.limit, limit);
      assert.equal(first.data.files, 2);
      assert.equal(first.data.trash, 0);

      // 删除后：已用减少、回收站增加
      const del = await fetch(`${server.base}/localsend/api/delete/${encodeURIComponent('a.bin')}`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      const after = await fetch(`${server.base}/localsend/api/usage`).then((r) => r.json());
      assert.equal(after.data.used, 50 * KB);
      assert.equal(after.data.files, 1);
      assert.equal(after.data.trash, 100 * KB);
      assert.equal(after.data.trashCount, 1);
    } finally {
      await server.close();
      removeDir(dir);
    }
  });

  it('未设上限时 limit 为 0', async () => {
    const dir = tempDir('ls-usage-nolimit-');
    const server = await startServer(dir, {});
    try {
      const usage = await fetch(`${server.base}/localsend/api/usage`).then((r) => r.json());
      assert.equal(usage.data.limit, 0);
      assert.equal(usage.data.used, 0);
    } finally {
      await server.close();
      removeDir(dir);
    }
  });
});
