/**
 * 文件整理（重命名 / 移动 / 批量重命名）的单元测试
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { removeDir, tempDir } = require('./helpers');

const { applyRenameRule, batchRename, moveFiles, parseRenameRule, renameFile, uniqueName } = require('../dist/localsend/manage');

describe('parseRenameRule', () => {
  it('缺省使用前缀模式', () => {
    const rule = parseRenameRule({});
    assert.equal(rule.mode, 'prefix');
    assert.equal(rule.prefix, '');
    assert.equal(rule.start, 1);
    assert.equal(rule.padding, 0);
    assert.equal(rule.template, '{n}');
  });

  it('识别四种规则类型，非法类型回退为前缀', () => {
    assert.equal(parseRenameRule({ mode: 'suffix' }).mode, 'suffix');
    assert.equal(parseRenameRule({ mode: 'replace' }).mode, 'replace');
    assert.equal(parseRenameRule({ mode: 'sequence' }).mode, 'sequence');
    assert.equal(parseRenameRule({ mode: 'unknown' }).mode, 'prefix');
  });

  it('收敛序号与补零位数', () => {
    const rule = parseRenameRule({ start: '3', padding: '99' });
    assert.equal(rule.start, 3);
    assert.equal(rule.padding, 10);
  });
});

describe('applyRenameRule', () => {
  it('添加前缀与后缀', () => {
    assert.equal(applyRenameRule('a.txt', parseRenameRule({ mode: 'prefix', prefix: '备份-' }), 0), '备份-a.txt');
    assert.equal(applyRenameRule('a.txt', parseRenameRule({ mode: 'suffix', suffix: '-副本' }), 0), 'a.txt-副本');
  });

  it('查找替换', () => {
    const rule = parseRenameRule({ mode: 'replace', find: '2024', replace: '2025' });
    assert.equal(applyRenameRule('照片2024.txt', rule, 0), '照片2025.txt');
    // 查找为空时保持原名，避免把整段名字清掉
    assert.equal(applyRenameRule('照片.txt', parseRenameRule({ mode: 'replace' }), 0), '照片.txt');
  });

  it('序号重命名支持补零与模板', () => {
    assert.equal(applyRenameRule('x', parseRenameRule({ mode: 'sequence' }), 0), '1');
    assert.equal(applyRenameRule('x', parseRenameRule({ mode: 'sequence', padding: 3 }), 0), '001');
    assert.equal(applyRenameRule('x', parseRenameRule({ mode: 'sequence', padding: 3, start: 9 }), 0), '009');
    assert.equal(applyRenameRule('x', parseRenameRule({ mode: 'sequence', template: '{name}_{n}' }), 2), 'x_3');
  });
});

describe('uniqueName', () => {
  it('同名时追加 _1 后缀', () => {
    const dir = tempDir('sserver-unique-');
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
      assert.equal(uniqueName(dir, 'a.txt'), 'a_1.txt');
      assert.equal(uniqueName(dir, 'b.txt'), 'b.txt');
    } finally {
      removeDir(dir);
    }
  });

  it('把本批次已占用的名字也算作冲突', () => {
    const dir = tempDir('sserver-unique-');
    try {
      const taken = new Set(['a.txt']);
      assert.equal(uniqueName(dir, 'a.txt', taken), 'a_1.txt');
    } finally {
      removeDir(dir);
    }
  });
});

describe('文件整理', () => {
  let dir;

  before(() => {
    dir = tempDir('sserver-manage-');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  });

  after(() => removeDir(dir));

  /** 写一个测试文件 */
  function write(name, content = 'x') {
    const full = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  }

  it('重命名文件', () => {
    write('a.txt');
    const result = renameFile(dir, 'a.txt', 'renamed.txt');
    assert.equal(result.code, 0);
    assert.equal(result.from, 'a.txt');
    assert.equal(result.to, 'renamed.txt');
    assert.equal(fs.existsSync(path.join(dir, 'renamed.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false);
  });

  it('目标重名时自动追加后缀', () => {
    write('x1.txt', 'x1');
    write('x2.txt', 'x2');
    const result = renameFile(dir, 'x1.txt', 'x2.txt');
    assert.equal(result.code, 0);
    assert.equal(result.to, 'x2_1.txt');
    // 原文件内容不受影响
    assert.equal(fs.readFileSync(path.join(dir, 'x2.txt'), 'utf8'), 'x2');
  });

  it('目标带目录时即跨目录移动', () => {
    write('m1.txt');
    const result = renameFile(dir, 'm1.txt', 'sub/moved.txt');
    assert.equal(result.code, 0);
    assert.equal(result.to, 'sub/moved.txt');
    assert.equal(fs.existsSync(path.join(dir, 'sub', 'moved.txt')), true);
  });

  it('目标目录不存在时自动创建', () => {
    write('m2.txt');
    const result = renameFile(dir, 'm2.txt', 'newdir/x.txt');
    assert.equal(result.code, 0);
    assert.equal(result.to, 'newdir/x.txt');
    assert.equal(fs.existsSync(path.join(dir, 'newdir', 'x.txt')), true);
  });

  it('重命名不存在的文件返回错误', () => {
    const result = renameFile(dir, 'not-exist.txt', 'x.txt');
    assert.equal(result.code, 1);
    assert.ok(result.msg);
  });

  it('拒绝越界路径', () => {
    const result = renameFile(dir, '../secret.txt', 'x.txt');
    assert.equal(result.code, 1);
  });

  it('批量移动到目录', () => {
    write('m3.txt');
    write('m4.jpg');
    const outcome = moveFiles(dir, ['m3.txt', 'm4.jpg'], 'sub');
    assert.equal(outcome.failed.length, 0);
    assert.equal(outcome.moved.length, 2);
    assert.equal(outcome.moved[0].to, 'sub/m3.txt');
    assert.equal(fs.existsSync(path.join(dir, 'sub', 'm4.jpg')), true);
  });

  it('移动到不存在的目录会自动创建', () => {
    write('m5.txt');
    const outcome = moveFiles(dir, ['m5.txt'], '归档/2026');
    assert.equal(outcome.failed.length, 0);
    assert.equal(outcome.moved[0].to, '归档/2026/m5.txt');
    assert.equal(fs.existsSync(path.join(dir, '归档', '2026', 'm5.txt')), true);
  });

  it('批量重命名按前缀规则', () => {
    write('归档/2026/p1.txt');
    const outcome = batchRename(dir, ['归档/2026/p1.txt'], parseRenameRule({ mode: 'prefix', prefix: '新-' }));
    assert.equal(outcome.failed.length, 0);
    assert.equal(outcome.renamed[0].to, '归档/2026/新-p1.txt');
    assert.equal(fs.existsSync(path.join(dir, '归档', '2026', '新-p1.txt')), true);
  });

  it('批量重命名按序号规则', () => {
    write('归档/2026/s1.txt');
    write('归档/2026/s2.jpg');
    const outcome = batchRename(dir, ['归档/2026/s1.txt', '归档/2026/s2.jpg'], parseRenameRule({ mode: 'sequence', padding: 2 }));
    assert.equal(outcome.failed.length, 0);
    assert.equal(outcome.renamed.length, 2);
    assert.equal(outcome.renamed[0].to, '归档/2026/01.txt');
    assert.equal(outcome.renamed[1].to, '归档/2026/02.jpg');
  });

  it('批量重命名可以按扩展名过滤', () => {
    write('归档/2026/e1.txt');
    write('归档/2026/e2.jpg');
    const outcome = batchRename(dir, ['归档/2026/e1.txt', '归档/2026/e2.jpg'], parseRenameRule({ mode: 'prefix', prefix: 'x-', ext: 'jpg' }));
    assert.equal(outcome.renamed.length, 1);
    assert.equal(outcome.skipped.length, 1);
    assert.equal(outcome.renamed[0].to, '归档/2026/x-e2.jpg');
  });

  it('批量重命名不会互相覆盖', () => {
    // a→b、b→c 这种互相占位的情况需要先落到临时名
    write('y1.txt', '1');
    write('y2.txt', '2');
    const outcome = batchRename(
      dir,
      ['y1.txt', 'y2.txt'],
      parseRenameRule({ mode: 'sequence', template: '{n}', padding: 0, start: 1 }),
    );
    assert.equal(outcome.failed.length, 0);
    assert.equal(outcome.renamed.length, 2);
    assert.equal(fs.existsSync(path.join(dir, '1.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, '2.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, 'y1.txt')), false);
  });

  it('批量重命名后不残留临时文件', () => {
    const leftovers = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{32}$/.test(n));
    assert.deepEqual(leftovers, []);
  });

  it('批量重命名遇到不存在的文件会记录失败', () => {
    const outcome = batchRename(dir, ['not-exist.txt'], parseRenameRule({ mode: 'prefix', prefix: 'z-' }));
    assert.equal(outcome.renamed.length, 0);
    assert.equal(outcome.failed.length, 1);
  });
});
