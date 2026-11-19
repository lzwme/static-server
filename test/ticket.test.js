/**
 * 短期访问票据
 *
 * 背景：下载 / 预览 / 打包 / 事件流的 URL 由浏览器直接发起，带不了请求头。
 * 以前把会话令牌拼在 URL 上（?session=），导致「复制链接」等于复制会话；
 * 现在改为「先换票、再用票访问」，票据只对指定文件有效且很快过期。
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createTicketStore, TICKET_TTL } = require('../dist/localsend/ticket');
const { startServer, tempDir, removeDir, upload, loginWithToken } = require('./helpers');

describe('票据存储', () => {
  it('签发后可按用途取回', () => {
    const store = createTicketStore();
    const entry = store.issue('download', ['a.txt']);
    assert.equal(entry.scope, 'download');
    assert.equal(store.get(entry.token, 'download').token, entry.token);
    // 用途不匹配时取不到：预览票据不能拿去下载
    assert.equal(store.get(entry.token, 'preview'), null);
    store.stop();
  });

  it('只允许访问签发时列出的文件', () => {
    const store = createTicketStore();
    const entry = store.issue('download', ['a.txt', 'dir/b.txt']);
    assert.equal(store.allows(entry, 'a.txt'), true);
    assert.equal(store.allows(entry, 'dir/b.txt'), true);
    assert.equal(store.allows(entry, 'c.txt'), false);
    // 没有列文件时不是万能钥匙
    const empty = store.issue('download', []);
    assert.equal(store.allows(empty, 'a.txt'), false);
    store.stop();
  });

  it('事件流票据不针对具体文件', () => {
    const store = createTicketStore();
    const entry = store.issue('events');
    assert.equal(store.allows(entry, 'anything.txt'), true);
    store.stop();
  });

  it('过期后取不到，清理会回收', () => {
    const store = createTicketStore({ ttl: 5 });
    const entry = store.issue('download', ['a.txt']);
    assert.equal(store.size(), 1);
    const wait = Date.now() + 20;
    while (Date.now() < wait) {
      // 忙等几毫秒，避免引入定时器依赖
    }
    assert.equal(store.get(entry.token), null);
    store.stop();
  });

  it('数量超过上限时淘汰最旧的票据', () => {
    const store = createTicketStore({ max: 3 });
    const first = store.issue('download', ['a.txt']);
    for (let i = 0; i < 5; i++) store.issue('download', [`f-${i}.txt`]);
    assert.ok(store.size() <= 3);
    assert.equal(store.get(first.token), null);
    store.stop();
  });

  it('默认有效期为 2 分钟', () => {
    const store = createTicketStore();
    const entry = store.issue('download', ['a.txt']);
    const ttl = entry.expiresAt - Date.now();
    assert.ok(ttl > TICKET_TTL - 2000 && ttl <= TICKET_TTL, `实际有效期 ${ttl}ms`);
    store.stop();
  });
});

describe('票据接口', () => {
  it('换票后无需会话即可下载、预览、打包', async () => {
    const dir = tempDir('ls-ticket-');
    // 开启访问令牌：票据接口本身需要会话，但票据 URL 不需要
    const server = await startServer(dir, { token: 'file-token' });
    try {
      const session = await loginWithToken(server.base, 'file-token');
      const headers = { 'X-Localsend-Session': session };
      await upload(server.base, 'a.txt', 'hello', '', headers);
      await upload(server.base, 'b.txt', 'world', '', headers);

      /** 换一张票据 */
      const issue = async (scope, names) => {
        const resp = await fetch(`${server.base}/localsend/api/ticket`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ scope, names }),
        });
        assert.equal(resp.status, 200);
        const json = await resp.json();
        assert.equal(json.code, 0);
        return json.data.token;
      };

      // 未带会话时不能换票
      const denied = await fetch(`${server.base}/localsend/api/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'download', names: ['a.txt'] }),
      });
      assert.equal(denied.status, 401);

      const downloadToken = await issue('download', ['a.txt']);
      const downloadResp = await fetch(`${server.base}/localsend/api/t/${downloadToken}/download/a.txt`);
      assert.equal(downloadResp.status, 200);
      assert.equal(await downloadResp.text(), 'hello');

      // 同一张票据不能访问未列出的文件
      const otherResp = await fetch(`${server.base}/localsend/api/t/${downloadToken}/download/b.txt`);
      assert.equal(otherResp.status, 403);

      const previewToken = await issue('preview', ['a.txt']);
      const previewResp = await fetch(`${server.base}/localsend/api/t/${previewToken}/preview/a.txt`);
      assert.equal(previewResp.status, 200);
      assert.equal(await previewResp.text(), 'hello');

      // 预览票据不能当下载票据用
      const wrongScope = await fetch(`${server.base}/localsend/api/t/${previewToken}/download/a.txt`);
      assert.equal(wrongScope.status, 401);

      const zipToken = await issue('zip', ['a.txt', 'b.txt']);
      const zipResp = await fetch(`${server.base}/localsend/api/t/${zipToken}/zip?names=${encodeURIComponent('a.txt,b.txt')}`);
      assert.equal(zipResp.status, 200);
      assert.equal(zipResp.headers.get('content-type'), 'application/zip');
      await zipResp.arrayBuffer();

      // 打包列表超出票据范围时拒绝
      const zipExtra = await fetch(`${server.base}/localsend/api/t/${zipToken}/zip?names=${encodeURIComponent('a.txt,c.txt')}`);
      assert.equal(zipExtra.status, 403);

      // 不存在的令牌给出明确的「过期」标记，便于前端重新换票
      const expired = await fetch(`${server.base}/localsend/api/t/not-a-token/download/a.txt`);
      assert.equal(expired.status, 401);
      const expiredJson = await expired.json();
      assert.equal(expiredJson.ticketExpired, true);
    } finally {
      await server.close();
      removeDir(dir);
    }
  });

  it('事件流票据可建立 SSE 连接', async () => {
    const dir = tempDir('ls-ticket-sse-');
    const server = await startServer(dir, {});
    try {
      const issueResp = await fetch(`${server.base}/localsend/api/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'events', names: [] }),
      });
      const token = (await issueResp.json()).data.token;
      const controller = new AbortController();
      const resp = await fetch(`${server.base}/localsend/api/t/${token}/events`, { signal: controller.signal });
      assert.equal(resp.status, 200);
      assert.match(resp.headers.get('content-type') || '', /text\/event-stream/);
      controller.abort();
    } finally {
      await server.close();
      removeDir(dir);
    }
  });

  it('换票接口拒绝不存在的文件', async () => {
    const dir = tempDir('ls-ticket-404-');
    const server = await startServer(dir, {});
    try {
      const resp = await fetch(`${server.base}/localsend/api/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'download', names: ['nope.txt'] }),
      });
      assert.equal(resp.status, 404);
    } finally {
      await server.close();
      removeDir(dir);
    }
  });
});
