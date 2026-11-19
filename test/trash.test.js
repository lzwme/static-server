/**
 * 回收站的单元测试
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, beforeEach, describe, it } = require('node:test');
const { removeDir, tempDir } = require('./helpers');

const { createTrash } = require('../dist/localsend/trash');

describe('回收站', () => {
  let dir;
  let trash;

  before(() => {
    dir = tempDir('sserver-trash-');
    trash = createTrash({ dir, ttl: 60_000, intervalMs: 60_000 });
  });

  after(() => {
    trash.stop();
    removeDir(dir);
  });

  /** 每个用例前重置目录与回收站，避免相互影响 */
  beforeEach(() => {
    trash.empty();
    fs.rmSync(path.join(dir, 'sub'), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'B');
  });

  it('删除后文件移入回收站且原位置消失', () => {
    const entry = trash.add('a.txt');
    assert.ok(entry);
    assert.equal(entry.name, 'a.txt');
    assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false);
    assert.equal(trash.list().length, 1);
  });

  it('还原后文件回到原位置', () => {
    const entry = trash.add('sub/b.txt');
    const restored = trash.restore(entry.id);
    assert.equal(restored, 'sub/b.txt');
    assert.equal(fs.readFileSync(path.join(dir, 'sub', 'b.txt'), 'utf8'), 'B');
  });

  it('原位置被占用时自动改名', () => {
    const entry = trash.add('a.txt');
    // 还原前原位置被别的文件占用
    fs.writeFileSync(path.join(dir, 'a.txt'), 'again');
    const restored = trash.restore(entry.id);
    assert.notEqual(restored, 'a.txt');
    assert.match(restored, /^a_\d+\.txt$/);
    assert.equal(fs.readFileSync(path.join(dir, restored), 'utf8'), 'A');
  });

  it('彻底删除后条目消失', () => {
    const entry = trash.add('sub/b.txt');
    assert.equal(trash.remove(entry.id), true);
    assert.equal(trash.list().length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'sub', 'b.txt')), false);
  });

  it('清空回收站返回删除数量', () => {
    trash.add('sub/b.txt');
    trash.add('a.txt');
    const removed = trash.empty();
    assert.equal(removed, 2);
    assert.equal(trash.list().length, 0);
  });

  it('还原不存在的条目返回空', () => {
    assert.equal(trash.restore('not-exist'), null);
    assert.equal(trash.remove('not-exist'), false);
  });
});
