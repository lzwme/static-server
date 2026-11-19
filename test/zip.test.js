/**
 * ZIP 打包的单元测试
 *
 * 重点验证中文文件名：条目名以 UTF-8 存储并置 EFS 标志位（bit 11），
 * 否则解压工具会按 CP437/本地代码页解释，中文将变成乱码。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { createZipChunks } = require('../dist/lib/zip');

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const FLAG_UTF8 = 0x0800;

/** 收集整个 zip 内容 */
async function makeZip(entries) {
  const chunks = [];
  for await (const chunk of createZipChunks(entries, async function* () {
    yield Buffer.from('hello');
  })) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 解析 zip，返回 local header 与 central directory 记录 */
function parseZip(buf) {
  const locals = [];
  const centrals = [];
  let pos = 0;
  // local file header
  while (pos + 30 <= buf.length && buf.readUInt32LE(pos) === LOCAL_SIG) {
    const flags = buf.readUInt16LE(pos + 6);
    const size = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const nameBuf = buf.subarray(pos + 30, pos + 30 + nameLen);
    const extra = buf.subarray(pos + 30 + nameLen, pos + 30 + nameLen + extraLen);
    locals.push({ flags, nameBuf, extra });
    pos += 30 + nameLen + extraLen + size;
  }
  // central directory
  while (pos + 46 <= buf.length && buf.readUInt32LE(pos) === CENTRAL_SIG) {
    const flags = buf.readUInt16LE(pos + 8);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const nameBuf = buf.subarray(pos + 46, pos + 46 + nameLen);
    const extra = buf.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);
    centrals.push({ flags, nameBuf, extra });
    pos += 46 + nameLen + extraLen;
  }
  return { locals, centrals };
}

describe('ZIP 打包与中文文件名', () => {
  it('local header 与中央目录都置 EFS 标志位', async () => {
    const buf = await makeZip([{ name: '中文文件.txt', path: 'x', mtime: new Date(2024, 0, 2, 3, 4, 5) }]);
    const { locals, centrals } = parseZip(buf);
    assert.equal(locals.length, 1);
    assert.equal(centrals.length, 1);
    assert.ok(locals[0].flags & FLAG_UTF8, 'local header 缺少 EFS 标志');
    assert.ok(centrals[0].flags & FLAG_UTF8, 'central directory 缺少 EFS 标志');
  });

  it('不再声明未使用的 data descriptor 标志位', async () => {
    const buf = await makeZip([{ name: 'a.txt', path: 'x', mtime: new Date() }]);
    const { locals, centrals } = parseZip(buf);
    assert.equal(locals[0].flags & 0x0008, 0);
    assert.equal(centrals[0].flags & 0x0008, 0);
  });

  it('文件名以 UTF-8 字节存储，可正确还原', async () => {
    const buf = await makeZip([{ name: '子目录/中文 文件名.txt', path: 'x', mtime: new Date() }]);
    const { locals, centrals } = parseZip(buf);
    assert.equal(locals[0].nameBuf.toString('utf8'), '子目录/中文 文件名.txt');
    assert.equal(centrals[0].nameBuf.toString('utf8'), '子目录/中文 文件名.txt');
    // 不能是 GBK 字节，否则在按 EFS 解码的工具里会显示为乱码
    assert.ok(locals[0].nameBuf.includes(Buffer.from('中文', 'utf8')));
  });

  it('非 ASCII 文件名附带 Unicode Path Extra Field', async () => {
    const buf = await makeZip([{ name: '中文.txt', path: 'x', mtime: new Date() }]);
    const { locals } = parseZip(buf);
    const extra = locals[0].extra;
    assert.ok(extra.length > 9, 'extra field 缺失');
    assert.equal(extra.readUInt16LE(0), 0x7075);
    assert.equal(extra.readUInt16LE(2), 1 + 4 + Buffer.byteLength('中文.txt'));
    assert.equal(extra.readUInt8(4), 1);
    assert.equal(extra.subarray(9).toString('utf8'), '中文.txt');
  });

  it('纯 ASCII 文件名不附加扩展字段', async () => {
    const buf = await makeZip([{ name: 'plain.txt', path: 'x', mtime: new Date() }]);
    const { locals, centrals } = parseZip(buf);
    assert.equal(locals[0].extra.length, 0);
    assert.equal(centrals[0].extra.length, 0);
  });

  it('多个条目都能正确记录偏移与名称', async () => {
    const buf = await makeZip([
      { name: '一.txt', path: 'x', mtime: new Date(2024, 0, 1) },
      { name: '二.txt', path: 'y', mtime: new Date(2024, 0, 2) },
      { name: 'sub/三.txt', path: 'z', mtime: new Date(2024, 0, 3) },
    ]);
    const { locals, centrals } = parseZip(buf);
    assert.equal(locals.length, 3);
    assert.equal(centrals.length, 3);
    assert.deepEqual(
      centrals.map((c) => c.nameBuf.toString('utf8')),
      ['一.txt', '二.txt', 'sub/三.txt'],
    );
  });
});
