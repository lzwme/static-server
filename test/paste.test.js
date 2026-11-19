/**
 * 剪贴板内容落盘与分享内联的单元测试
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { removeDir, tempDir } = require('./helpers');

const {
  MAX_TEXT_SIZE,
  buildPasteName,
  contentHash,
  extOfMime,
  parseDataUrl,
  parsePaste,
  parseStrategy,
  timeStampTag,
} = require('../dist/localsend/paste');
const { shareInlineMime, shareInlineType } = require('../dist/localsend/share');

/** 构造一个 1x1 的 PNG data URL */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('剪贴板内容解析', () => {
  it('解析文本内容', () => {
    const parsed = parsePaste({ kind: 'text', content: 'hello localsend' });
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.ext, 'txt');
    assert.equal(parsed.buffer.toString('utf8'), 'hello localsend');
  });

  it('空文本返回错误', () => {
    assert.ok(parsePaste({ kind: 'text', content: '' }).error);
  });

  it('超大文本被拒绝', () => {
    const big = 'x'.repeat(MAX_TEXT_SIZE + 10);
    const parsed = parsePaste({ kind: 'text', content: big });
    assert.ok(parsed.error);
    assert.match(parsed.error, /过大/);
  });

  it('解析图片 data URL', () => {
    const parsed = parsePaste({ kind: 'image', content: PNG_DATA_URL });
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.ext, 'png');
    assert.equal(parsed.mime, 'image/png');
    assert.ok(parsed.buffer.length > 0);
  });

  it('非法图片数据返回错误', () => {
    assert.ok(parsePaste({ kind: 'image', content: 'not-a-data-url' }).error);
  });

  it('不支持的图片格式被拒绝', () => {
    const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    const parsed = parsePaste({ kind: 'image', content: svg });
    assert.ok(parsed.error);
    assert.match(parsed.error, /不支持/);
  });

  it('MIME 与扩展名对应关系', () => {
    assert.equal(extOfMime('image/png'), 'png');
    assert.equal(extOfMime('image/jpeg'), 'jpg');
    assert.equal(extOfMime('image/webp'), 'webp');
    assert.equal(extOfMime('text/plain'), '');
  });

  it('解析 data URL', () => {
    const parsed = parseDataUrl(PNG_DATA_URL);
    assert.equal(parsed.mime, 'image/png');
    assert.ok(parsed.buffer.length > 0);
    assert.equal(parseDataUrl('xxx'), null);
  });
});

describe('文件名生成策略', () => {
  const base = { kind: 'text', hash: 'a1b2c3d4', stamp: '20261118-221530' };

  it('哈希策略用内容 md5 前 8 位', () => {
    assert.equal(buildPasteName({ ...base, strategy: 'hash' }, 'txt'), '文本-a1b2c3d4.txt');
    assert.equal(buildPasteName({ ...base, kind: 'image', strategy: 'hash' }, 'png'), '截图-a1b2c3d4.png');
  });

  it('时间戳策略', () => {
    assert.equal(buildPasteName({ ...base, strategy: 'timestamp' }, 'txt'), '文本-20261118-221530.txt');
  });

  it('自定义策略使用指定名字，缺扩展名时补上', () => {
    assert.equal(buildPasteName({ ...base, strategy: 'custom', name: '我的笔记.txt' }, 'txt'), '我的笔记.txt');
    assert.equal(buildPasteName({ ...base, strategy: 'custom', name: '我的笔记' }, 'txt'), '我的笔记.txt');
  });

  it('自定义名字里的目录会被丢弃（目录由 dir 参数决定）', () => {
    assert.equal(buildPasteName({ ...base, strategy: 'custom', name: '子目录/笔记.txt' }, 'txt'), '笔记.txt');
  });

  it('自定义策略缺少名字时回退到哈希策略', () => {
    assert.equal(buildPasteName({ ...base, strategy: 'custom' }, 'txt'), '文本-a1b2c3d4.txt');
  });

  it('非法策略回退到哈希策略', () => {
    assert.equal(parseStrategy('whatever'), 'hash');
    assert.equal(parseStrategy('timestamp'), 'timestamp');
    assert.equal(parseStrategy('custom'), 'custom');
  });

  it('内容哈希稳定且区分不同内容', () => {
    const a = contentHash(Buffer.from('hello'));
    const b = contentHash(Buffer.from('hello'));
    const c = contentHash(Buffer.from('world'));
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(a.length, 8);
  });

  it('时间戳片段格式为 20261118-221530', () => {
    const tag = timeStampTag(new Date(2026, 10, 18, 22, 15, 30));
    assert.equal(tag, '20261118-221530');
  });
});

describe('分享内联类型', () => {
  it('文本与图片可内联打开', () => {
    assert.equal(shareInlineType('a.txt'), 'text');
    assert.equal(shareInlineType('a.md'), 'text');
    assert.equal(shareInlineType('a.json'), 'text');
    assert.equal(shareInlineType('a.png'), 'image');
    assert.equal(shareInlineType('a.jpg'), 'image');
  });

  it('html 与 svg 不内联，避免同源脚本执行', () => {
    assert.equal(shareInlineType('a.html'), null);
    assert.equal(shareInlineType('a.svg'), null);
    assert.equal(shareInlineType('a.exe'), null);
  });

  it('内联时使用正确的 Content-Type', () => {
    assert.equal(shareInlineMime('a.txt'), 'text/plain; charset=utf-8');
    assert.equal(shareInlineMime('a.png'), 'image/png');
    assert.equal(shareInlineMime('a.jpg'), 'image/jpeg');
  });
});

describe('剪贴板落盘', () => {
  let dir;

  before(() => {
    dir = tempDir('sserver-paste-');
  });

  after(() => removeDir(dir));

  it('文本写入文件并返回哈希', () => {
    const parsed = parsePaste({ kind: 'text', content: '写进磁盘的文本' });
    const name = buildPasteName({ kind: 'text', hash: contentHash(parsed.buffer), stamp: timeStampTag(), strategy: 'hash' }, parsed.ext);
    fs.writeFileSync(path.join(dir, name), parsed.buffer);
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), '写进磁盘的文本');
  });
});
