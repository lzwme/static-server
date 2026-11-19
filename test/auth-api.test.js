/**
 * 访问控制与权限分级的集成测试
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { fetchSalts, digestOf, listFiles, login, loginWithToken, removeDir, startServer, tempDir, upload } = require('./helpers');

/** 调用一个 JSON 接口，可选带上会话令牌 */
async function call(base, path_, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  const resp = await fetch(`${base}/localsend/api${path_}`, { ...init, headers });
  return { status: resp.status, json: await resp.json() };
}

describe('LocalSend 权限分级', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = tempDir('sserver-auth-');
    server = await startServer(dir, { password: 'admin-pwd', visitorPassword: 'guest-pwd' });
    base = server.base;
    // 管理员登录后才有上传权限
    const token = await login(base, 'admin-pwd');
    await upload(base, 'a.txt', 'aaa', '', { 'X-Localsend-Session': token });
  });

  after(async () => {
    if (server) await server.close();
    removeDir(dir);
  });

  it('未登录时是只读身份', async () => {
    const { json } = await call(base, '/session');
    assert.equal(json.code, 0);
    assert.equal(json.data.role, 'guest');
    assert.equal(json.data.open, false);
    assert.equal(json.data.hasAdmin, true);
    assert.equal(json.data.hasVisitor, true);
  });

  it('未登录不能删除文件', async () => {
    const resp = await fetch(`${base}/localsend/api/delete/a.txt`, { method: 'DELETE' });
    assert.equal(resp.status, 403);
    const json = await resp.json();
    assert.equal(json.code, 1);
    assert.match(json.msg, /管理员权限/);
    assert.equal(fs.existsSync(path.join(dir, 'a.txt')), true);
  });

  it('未登录不能批量删除', async () => {
    const { status } = await call(base, '/delete-batch', { method: 'POST', body: JSON.stringify({ names: ['a.txt'] }) });
    assert.equal(status, 403);
  });

  it('未登录不能上传', async () => {
    const { status } = await upload(base, 'guest.txt', 'x');
    assert.equal(status, 403);
    assert.equal(fs.existsSync(path.join(dir, 'guest.txt')), false);
  });

  it('未登录不能整理目录', async () => {
    const rename = await call(base, '/rename', { method: 'POST', body: JSON.stringify({ from: 'a.txt', to: 'b.txt' }) });
    assert.equal(rename.status, 403);
    const move = await call(base, '/move', { method: 'POST', body: JSON.stringify({ names: ['a.txt'], dir: 'sub' }) });
    assert.equal(move.status, 403);
    const batch = await call(base, '/rename-batch', { method: 'POST', body: JSON.stringify({ names: ['a.txt'], rule: { mode: 'prefix', prefix: 'x-' } }) });
    assert.equal(batch.status, 403);
  });

  it('未登录不能撤销分享', async () => {
    const { status } = await call(base, '/share/some-token', { method: 'DELETE' });
    assert.equal(status, 403);
  });

  it('未登录可以浏览与下载', async () => {
    const files = await listFiles(base);
    assert.equal(files.length, 1);
    const resp = await fetch(`${base}/localsend/api/download/a.txt`);
    assert.equal(resp.status, 200);
  });

  it('口令错误无法登录', async () => {
    const salts = await fetchSalts(base);
    const { status, json } = await call(base, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ digests: { password: digestOf(salts, 'password', 'wrong') } }),
    });
    assert.equal(status, 401);
    assert.equal(json.code, 1);
  });

  it('明文口令不再被接受', async () => {
    const { status } = await call(base, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ digests: { password: 'admin-pwd' } }),
    });
    assert.equal(status, 401);
  });

  it('访客登录后可以上传但不能删除', async () => {
    const token = await login(base, 'guest-pwd');
    assert.ok(token);
    const session = await call(base, '/session', { headers: { 'X-Localsend-Session': token } });
    assert.equal(session.json.data.role, 'visitor');

    const up = await upload(base, 'visitor.txt', 'v', '', { 'X-Localsend-Session': token });
    assert.equal(up.status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'visitor.txt')), true);

    const del = await fetch(`${base}/localsend/api/delete/visitor.txt`, {
      method: 'DELETE',
      headers: { 'X-Localsend-Session': token },
    });
    assert.equal(del.status, 403);
    assert.equal(fs.existsSync(path.join(dir, 'visitor.txt')), true);
  });

  it('访客可以创建分享链接', async () => {
    const token = await login(base, 'guest-pwd');
    const { status, json } = await call(base, '/share', {
      method: 'POST',
      headers: { 'X-Localsend-Session': token },
      body: JSON.stringify({ names: ['visitor.txt'] }),
    });
    assert.equal(status, 200);
    assert.equal(json.code, 0);
    assert.ok(json.data.url);
  });

  it('管理员登录后可以删除与整理', async () => {
    const token = await login(base, 'admin-pwd');
    assert.ok(token);
    const session = await call(base, '/session', { headers: { 'X-Localsend-Session': token } });
    assert.equal(session.json.data.role, 'admin');

    const del = await fetch(`${base}/localsend/api/delete/visitor.txt`, {
      method: 'DELETE',
      headers: { 'X-Localsend-Session': token },
    });
    assert.equal(del.status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'visitor.txt')), false);

    const rename = await call(base, '/rename', {
      method: 'POST',
      headers: { 'X-Localsend-Session': token },
      body: JSON.stringify({ from: 'a.txt', to: 'renamed.txt' }),
    });
    assert.equal(rename.json.code, 0);
    assert.equal(fs.existsSync(path.join(dir, 'renamed.txt')), true);
  });

  it('注销后会话立即失效', async () => {
    const token = await login(base, 'admin-pwd');
    const out = await call(base, '/logout', { method: 'POST', headers: { 'X-Localsend-Session': token } });
    assert.equal(out.json.code, 0);
    const del = await fetch(`${base}/localsend/api/delete/renamed.txt`, {
      method: 'DELETE',
      headers: { 'X-Localsend-Session': token },
    });
    assert.equal(del.status, 403);
  });
});

describe('LocalSend 仅配置管理员口令', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = tempDir('sserver-adminonly-');
    server = await startServer(dir, { password: 'admin-pwd' });
    base = server.base;
  });

  after(async () => {
    if (server) await server.close();
    removeDir(dir);
  });

  it('未配置访客口令时未登录也可以上传下载', async () => {
    const { json } = await call(base, '/session');
    assert.equal(json.data.role, 'guest');
    assert.equal(json.data.hasVisitor, false);

    const up = await upload(base, 'anyone.txt', 'a');
    assert.equal(up.status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'anyone.txt')), true);

    const down = await fetch(`${base}/localsend/api/download/anyone.txt`);
    assert.equal(down.status, 200);
  });

  it('未登录仍然不能删除与整理', async () => {
    const del = await fetch(`${base}/localsend/api/delete/anyone.txt`, { method: 'DELETE' });
    assert.equal(del.status, 403);
    assert.equal(fs.existsSync(path.join(dir, 'anyone.txt')), true);

    const rename = await call(base, '/rename', { method: 'POST', body: JSON.stringify({ from: 'anyone.txt', to: 'other.txt' }) });
    assert.equal(rename.status, 403);
  });
});

describe('LocalSend 开放模式', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = tempDir('sserver-open-');
    server = await startServer(dir);
    base = server.base;
    await upload(base, 'x.txt', 'x');
  });

  after(async () => {
    if (server) await server.close();
    removeDir(dir);
  });

  it('没有配置口令时行为与以前一致', async () => {
    const { json } = await call(base, '/session');
    assert.equal(json.data.role, 'open');
    assert.equal(json.data.open, true);
    const resp = await fetch(`${base}/localsend/api/delete/x.txt`, { method: 'DELETE' });
    assert.equal(resp.status, 200);
  });
});

describe('LocalSend 访问令牌保护', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = tempDir('sserver-token-');
    server = await startServer(dir, { token: 'secret-key' });
    base = server.base;
    fs.writeFileSync(path.join(dir, 'secret.txt'), '机密');
  });

  after(async () => {
    if (server) await server.close();
    removeDir(dir);
  });

  it('未换取会话时接口一律拒绝', async () => {
    const noKey = await fetch(`${base}/localsend/api/list`);
    assert.equal(noKey.status, 401);
    const json = await noKey.json();
    assert.equal(json.needToken, true);
  });

  it('页面与静态资源不需要令牌即可加载', async () => {
    const page = await fetch(`${base}/localsend`);
    assert.equal(page.status, 200);
    const script = await fetch(`${base}/localsend/crypto.js`);
    assert.equal(script.status, 200);
  });

  it('地址栏里带 key 的老链接不再被接受', async () => {
    const withKey = await fetch(`${base}/localsend/api/list?key=secret-key`);
    assert.equal(withKey.status, 401);
  });

  it('用令牌摘要换取会话后接口正常', async () => {
    const session = await loginWithToken(base, 'secret-key');
    assert.ok(session);
    const list = await fetch(`${base}/localsend/api/list`, { headers: { 'X-Localsend-Session': session } });
    assert.equal(list.status, 200);
  });

  it('令牌摘要也可以直接放在请求头里', async () => {
    const salts = await fetchSalts(base);
    const digest = digestOf(salts, 'token', 'secret-key');
    const list = await fetch(`${base}/localsend/api/list`, { headers: { 'X-Localsend-Key': digest } });
    assert.equal(list.status, 200);
  });

  it('分享接口不能绕过令牌创建链接', async () => {
    const { status } = await call(base, '/share', { method: 'POST', body: JSON.stringify({ names: ['secret.txt'] }) });
    assert.equal(status, 401);
  });

  it('分享接口不能绕过令牌列出链接', async () => {
    const { status } = await call(base, '/share');
    assert.equal(status, 401);
  });

  it('剪贴板接口不能绕过令牌写入内容', async () => {
    const { status } = await call(base, '/paste', { method: 'POST', body: JSON.stringify({ kind: 'text', content: 'x' }) });
    assert.equal(status, 401);
    assert.equal(fs.existsSync(path.join(dir, '文本-e2fc064c.txt')), false);
  });

  it('换取会话后分享接口正常', async () => {
    const session = await loginWithToken(base, 'secret-key');
    const { status, json } = await call(base, '/share', {
      method: 'POST',
      headers: { 'X-Localsend-Session': session },
      body: JSON.stringify({ names: ['secret.txt'] }),
    });
    assert.equal(status, 200);
    assert.ok(json.data.url);
  });

  it('统一登录入口也接受访问令牌摘要', async () => {
    // 前端只有一个输入框：令牌与口令一起提交，由服务端判断是哪一种
    const salts = await fetchSalts(base);
    const { status, json } = await call(base, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ digests: { token: digestOf(salts, 'token', 'secret-key') } }),
    });
    assert.equal(status, 200);
    assert.equal(json.code, 0);
    assert.equal(json.data.via, 'token');
    assert.ok(json.data.token);

    const list = await fetch(`${base}/localsend/api/list`, {
      headers: { 'X-Localsend-Session': json.data.token },
    });
    assert.equal(list.status, 200);
  });

  it('统一登录入口收到的错误凭据一律拒绝', async () => {
    const salts = await fetchSalts(base);
    const { status } = await call(base, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        digests: {
          password: digestOf(salts, 'password', 'nope'),
          token: digestOf(salts, 'token', 'nope'),
        },
      }),
    });
    assert.equal(status, 401);
  });
});
