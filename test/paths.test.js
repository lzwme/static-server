/**
 * 路径与文件列表相关工具的单元测试
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { removeDir, tempDir } = require('./helpers');

const { INTERNAL_DIR_NAMES, isInternalDirName, listDirs, listFiles, resolveInDir, safeRelPath } = require('../dist/lib/localsend/path');

describe('safeRelPath', () => {
  it('保留普通文件名与子目录', () => {
    assert.equal(safeRelPath('a.txt'), 'a.txt');
    assert.equal(safeRelPath('sub/dir/a.txt'), 'sub/dir/a.txt');
    assert.equal(safeRelPath('sub\\dir\\a.txt'), 'sub/dir/a.txt');
  });

  it('拒绝越界路径', () => {
    assert.equal(safeRelPath('../a.txt'), '');
    assert.equal(safeRelPath('sub/../../a.txt'), '');
    // 绝对路径会被去掉开头的斜杠，仍然落在存储目录内
    assert.equal(safeRelPath('/etc/passwd'), 'etc/passwd');
    // 盘符路径直接拒绝
    assert.equal(safeRelPath('C:\\Windows\\system32\\cmd.exe'), '');
  });

  it('拒绝空值，数字按文件名处理', () => {
    assert.equal(safeRelPath(''), '');
    assert.equal(safeRelPath(undefined), '');
    assert.equal(safeRelPath(null), '');
    assert.equal(safeRelPath('   '), '');
    // 非字符串会被转成文件名形式，不会产生越界路径
    assert.equal(safeRelPath(123), '123');
    assert.equal(safeRelPath({ toString: () => '../evil.txt' }), '');
  });
});

describe('resolveInDir', () => {
  const base = path.resolve('D:/tmp/base');

  it('正常拼接子路径', () => {
    assert.equal(resolveInDir(base, 'a.txt'), path.join(base, 'a.txt'));
  });

  it('拒绝逃出基础目录的路径', () => {
    // 非法路径统一返回空串（调用方以 falsy 判断）
    assert.equal(resolveInDir(base, '../secret.txt'), '');
    assert.equal(resolveInDir(base, 'sub/../../secret.txt'), '');
    assert.equal(resolveInDir(base, '.chunks/tmp.bin'), '');
  });
});

describe('isInternalDirName', () => {
  it('识别内部目录', () => {
    assert.equal(isInternalDirName('.chunks'), true);
    assert.equal(isInternalDirName('.trash'), true);
    assert.equal(isInternalDirName('.git'), false);
    assert.equal(isInternalDirName('chunks'), false);
  });

  it('内部目录清单与实现一致', () => {
    assert.deepEqual(INTERNAL_DIR_NAMES, ['.chunks', '.trash']);
  });
});

describe('listFiles', () => {
  let dir;

  before(() => {
    dir = tempDir('sserver-list-');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.chunks'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.trash'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'root.txt'), 'root');
    fs.writeFileSync(path.join(dir, 'sub', 'nested.txt'), 'nested');
    fs.writeFileSync(path.join(dir, '.chunks', 'tmp.bin'), 'chunk');
    fs.writeFileSync(path.join(dir, '.trash', 'item-1'), 'trash');
  });

  after(() => removeDir(dir));

  it('递归列出文件并跳过内部目录', () => {
    const names = listFiles(dir).map((f) => f.name).sort();
    assert.deepEqual(names, ['root.txt', 'sub/nested.txt']);
  });

  it('返回的条目包含大小与扩展名', () => {
    const root = listFiles(dir).find((f) => f.name === 'root.txt');
    assert.equal(root.size, 4);
    assert.equal(root.ext, 'txt');
    assert.equal(root.isDir, false);
  });

  it('支持过滤函数', () => {
    const names = listFiles(dir, (rel) => rel.startsWith('sub/')).map((f) => f.name);
    assert.deepEqual(names, ['sub/nested.txt']);
  });

  it('listDirs 只返回一级子目录且不含内部目录', () => {
    const dirs = listDirs(dir).sort();
    assert.deepEqual(dirs, ['sub']);
  });
});
