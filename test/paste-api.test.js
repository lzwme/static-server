/**
 * 剪贴板分享接口的集成测试
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { listPage, removeDir, startServer, tempDir } = require('./helpers');

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 调用一个 JSON 接口 */
async function post(base, path_, body) {
  const resp = await fetch(`${base}/localsend/api${path_}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json() };
}

describe('LocalSend 剪贴板分享接口', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = tempDir('sserver-paste-api-');
    server = await startServer(dir);
    base = server.base;
  });

  after(async () => {
    if (server) await server.close();
    removeDir(dir);
  });

  it('文本内容落盘为 txt 文件', async () => {
    const { status, json } = await post(base, '/paste', { kind: 'text', content: '分享一段文字' });
    assert.equal(status, 200);
    assert.equal(json.code, 0);
    assert.match(json.data.name, /^文本-[0-9a-f]{8}\.txt$/);
    assert.equal(fs.readFileSync(path.join(dir, json.data.name), 'utf8'), '分享一段文字');
    assert.equal(json.data.reused, false);
  });

  it('相同内容再次粘贴会复用已有文件', async () => {
    const first = await post(base, '/paste', { kind: 'text', content: '重复内容' });
    const second = await post(base, '/paste', { kind: 'text', content: '重复内容' });
    assert.equal(first.json.data.name, second.json.data.name);
    assert.equal(second.json.data.reused, true);
    // 同一内容只落一份文件
    const dup = fs.readdirSync(dir).filter((n) => n === first.json.data.name);
    assert.equal(dup.length, 1);
  });

  it('时间戳策略生成带时间的文件名', async () => {
    const { json } = await post(base, '/paste', { kind: 'text', content: '带时间戳', strategy: 'timestamp' });
    assert.match(json.data.name, /^文本-\d{8}-\d{6}\.txt$/);
  });

  it('自定义文件名策略', async () => {
    const { json } = await post(base, '/paste', { kind: 'text', content: '自定义名字', strategy: 'custom', name: '我的笔记.txt' });
    assert.equal(json.data.name, '我的笔记.txt');
  });

  it('可以指定存放目录，目录不存在时自动创建', async () => {
    const { json } = await post(base, '/paste', { kind: 'text', content: '归档内容', dir: '剪贴板/2026' });
    assert.equal(json.data.name, '剪贴板/2026/文本-' + json.data.hash + '.txt');
    assert.equal(fs.existsSync(path.join(dir, '剪贴板', '2026')), true);
  });

  it('图片内容落盘为图片文件', async () => {
    const { status, json } = await post(base, '/paste', { kind: 'image', content: PNG_DATA_URL });
    assert.equal(status, 200);
    assert.match(json.data.name, /^截图-[0-9a-f]{8}\.png$/);
    assert.equal(fs.existsSync(path.join(dir, json.data.name)), true);
  });

  it('空内容与非法图片被拒绝', async () => {
    const empty = await post(base, '/paste', { kind: 'text', content: '' });
    assert.equal(empty.status, 400);
    const bad = await post(base, '/paste', { kind: 'image', content: 'nope' });
    assert.equal(bad.status, 400);
  });

  it('拒绝越界的存放目录', async () => {
    const { status } = await post(base, '/paste', { kind: 'text', content: '越界', dir: '../evil' });
    assert.equal(status, 400);
    assert.equal(fs.existsSync(path.join(dir, '..', 'evil')), false);
  });

  it('粘贴的内容出现在文件列表里', async () => {
    const pasted = await post(base, '/paste', { kind: 'text', content: '列表可见内容' });
    // 列表按相对路径匹配，粘贴的文件名形如「文本-<hash>.txt」
    const page = await listPage(base, `?q=${encodeURIComponent(pasted.json.data.name)}`);
    assert.equal(page.total, 1);
    assert.equal(page.items[0].name, pasted.json.data.name);
  });

  it('粘贴的内容可以生成分享链接并下载', async () => {
    const pasted = await post(base, '/paste', { kind: 'text', content: '分享链接测试内容' });
    const shared = await post(base, '/share', { names: [pasted.json.data.name] });
    assert.equal(shared.json.code, 0);
    const link = shared.json.data.url;
    const resp = await fetch(`${base}${link}`);
    assert.equal(resp.status, 200);
    assert.equal(await resp.text(), '分享链接测试内容');
  });

  it('文本分享链接默认内联打开', async () => {
    const pasted = await post(base, '/paste', { kind: 'text', content: '内联展示' });
    const shared = await post(base, '/share', { names: [pasted.json.data.name] });
    const resp = await fetch(`${base}${shared.json.data.url}`);
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') || '', /text\/plain/);
    assert.match(resp.headers.get('content-disposition') || '', /inline/);
  });

  it('加 dl=1 时强制下载', async () => {
    const pasted = await post(base, '/paste', { kind: 'text', content: '强制下载' });
    const shared = await post(base, '/share', { names: [pasted.json.data.name] });
    const resp = await fetch(`${base}${shared.json.data.url}?dl=1`);
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-disposition') || '', /attachment/);
  });
});
