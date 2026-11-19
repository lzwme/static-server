/**
 * 认证失效的处理
 *
 * 未授权不是普通错误，它必须能被区分成两种情况，
 * 客户端才能知道该弹「输入访问令牌」还是「重新登录」：
 *
 *  - needToken：没带凭证（或令牌不对），需要输入访问令牌
 *  - needLogin：带了会话但服务端不认（口令改了、会话过期、服务重启），需要重新登录
 *
 * 另外还覆盖一个真实场景：服务端换了口令，客户端还拿着旧会话、
 * 页面又没刷新过时，旧会话必须立刻失效并给出明确的重新登录信号。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { digestOf, fetchSalts, login, loginWithToken, removeDir, startServer, tempDir } = require('./helpers');

/** 调用一个 JSON 接口，可选带上会话令牌 */
async function call(base, path_, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  const resp = await fetch(`${base}/localsend/api${path_}`, { ...init, headers });
  return { status: resp.status, json: await resp.json() };
}

/**
 * 启动一个带独立运行时设置文件的服务。
 *
 * 改口令、改令牌都会写进运行时设置文件，而这个文件在同一进程里是共享的：
 * 不隔离的话，上一个用例改过的口令会漏到下一个用例里。
 */
async function startIsolatedServer(dir, extra) {
  const settingsFile = path.join(tempDir('sserver-authfail-cfg-'), 'settings.json');
  process.env.SS_LOCALSEND_SETTINGS = settingsFile;
  const server = await startServer(dir, extra);
  return {
    ...server,
    async close() {
      await server.close();
      delete process.env.SS_LOCALSEND_SETTINGS;
    },
  };
}

describe('会话失效与缺令牌的区分', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = tempDir('sserver-authfail-');
    // 同时配置令牌与管理员口令，覆盖两类凭据都存在的部署
    server = await startIsolatedServer(dir, { token: 'secret-key', password: 'admin-pwd' });
    base = server.base;
  });

  after(async () => {
    if (server) await server.close();
    removeDir(dir);
  });

  it('没带任何凭证时提示需要访问令牌', async () => {
    const { status, json } = await call(base, '/list');
    assert.equal(status, 401);
    assert.equal(json.needToken, true);
    assert.equal(json.needLogin, undefined);
  });

  it('带了服务端不认的会话时提示会话失效（而不是缺令牌）', async () => {
    const { status, json } = await call(base, '/list', { headers: { 'X-Localsend-Session': 'stale-session' } });
    assert.equal(status, 401);
    assert.equal(json.needLogin, true);
    assert.equal(json.needToken, undefined);
    assert.match(json.msg, /会话已失效/);
  });

  it('查询参数里的无效会话同样按会话失效处理', async () => {
    const resp = await fetch(`${base}/localsend/api/list?session=stale-session`);
    assert.equal(resp.status, 401);
    const json = await resp.json();
    assert.equal(json.needLogin, true);
  });

  it('有效会话照常放行', async () => {
    const session = await loginWithToken(base, 'secret-key');
    assert.ok(session);
    const { status } = await call(base, '/list', { headers: { 'X-Localsend-Session': session } });
    assert.equal(status, 200);
  });

  it('用口令登录的会话在有令牌时也照常放行', async () => {
    const session = await login(base, 'admin-pwd');
    assert.ok(session);
    const { status, json } = await call(base, '/session', { headers: { 'X-Localsend-Session': session } });
    assert.equal(status, 200);
    assert.equal(json.data.role, 'admin');
  });
});

describe('没有访问令牌时的会话失效', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = tempDir('sserver-nokey-');
    server = await startIsolatedServer(dir, { password: 'admin-pwd' });
    base = server.base;
  });

  after(async () => {
    if (server) await server.close();
    removeDir(dir);
  });

  it('带着失效会话仍按访客口径放行，不阻断读取', async () => {
    // 没配令牌时接口不设大门锁：失效会话降级为访客即可，
    // 否则一次会话过期就会把整个页面锁死
    const { status, json } = await call(base, '/session', { headers: { 'X-Localsend-Session': 'stale-session' } });
    assert.equal(status, 200);
    assert.equal(json.data.role, 'guest');
    assert.equal(json.data.sessionValid, false);
  });

  it('失效会话无法执行管理员操作', async () => {
    const resp = await fetch(`${base}/localsend/api/delete/a.txt`, {
      method: 'DELETE',
      headers: { 'X-Localsend-Session': 'stale-session' },
    });
    assert.equal(resp.status, 403);
    const json = await resp.json();
    assert.equal(json.needAuth, true);
  });
});

describe('服务端更换口令后旧会话立即失效', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = tempDir('sserver-repass-');
    server = await startIsolatedServer(dir, { token: 'secret-key', password: 'admin-pwd' });
    base = server.base;
  });

  after(async () => {
    if (server) await server.close();
    removeDir(dir);
  });

  it('改口令后其他客户端的旧会话拿到明确的失效信号', async () => {
    // 模拟「另一个客户端已经登录、页面没刷新」的状态
    const adminSession = await login(base, 'admin-pwd');
    const otherSession = await login(base, 'admin-pwd');
    assert.ok(adminSession);
    assert.ok(otherSession);
    const before = await call(base, '/session', { headers: { 'X-Localsend-Session': otherSession } });
    assert.equal(before.json.data.sessionValid, true);

    // 管理员在另一个地方改了口令
    const salts = await fetchSalts(base);
    const currentDigest = digestOf(salts, 'password', 'admin-pwd');
    const changed = await call(base, '/settings', {
      method: 'POST',
      headers: { 'X-Localsend-Session': adminSession },
      body: JSON.stringify({ changes: { password: 'new-admin-pwd' }, currentPasswordDigest: currentDigest }),
    });
    assert.equal(changed.status, 200);

    // 旧会话必须立刻失效，并告诉客户端「要重新登录」
    const after = await call(base, '/list', { headers: { 'X-Localsend-Session': otherSession } });
    assert.equal(after.status, 401);
    assert.equal(after.json.needLogin, true);

    // 发起变更的那个会话仍然有效（改完口令不至于把自己踢下线）
    const self = await call(base, '/session', { headers: { 'X-Localsend-Session': adminSession } });
    assert.equal(self.status, 200);
    assert.equal(self.json.data.sessionValid, true);
  });

  it('改口令后用新口令可以重新登录', async () => {
    const session = await login(base, 'new-admin-pwd');
    assert.ok(session);
    const { json } = await call(base, '/session', { headers: { 'X-Localsend-Session': session } });
    assert.equal(json.data.role, 'admin');
  });

  it('改口令后旧口令不能再登录', async () => {
    const session = await login(base, 'admin-pwd');
    assert.equal(session, '');
  });
});

describe('更换访问令牌后的会话失效范围', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = tempDir('sserver-retoken-');
    server = await startIsolatedServer(dir, { token: 'old-key', password: 'admin-pwd' });
    base = server.base;
  });

  after(async () => {
    if (server) await server.close();
    removeDir(dir);
  });

  it('改令牌只作废令牌换来的会话，口令登录的会话继续有效', async () => {
    const tokenSession = await loginWithToken(base, 'old-key');
    const passwordSession = await login(base, 'admin-pwd');
    assert.ok(tokenSession);
    assert.ok(passwordSession);

    const salts = await fetchSalts(base);
    const currentDigest = digestOf(salts, 'password', 'admin-pwd');
    const changed = await call(base, '/settings', {
      method: 'POST',
      headers: { 'X-Localsend-Session': passwordSession },
      body: JSON.stringify({ changes: { token: 'new-key' }, currentPasswordDigest: currentDigest }),
    });
    assert.equal(changed.status, 200);

    // 令牌会话失效
    const tokenAfter = await call(base, '/list', { headers: { 'X-Localsend-Session': tokenSession } });
    assert.equal(tokenAfter.status, 401);
    assert.equal(tokenAfter.json.needLogin, true);

    // 口令会话不受影响
    const passwordAfter = await call(base, '/session', { headers: { 'X-Localsend-Session': passwordSession } });
    assert.equal(passwordAfter.status, 200);
    assert.equal(passwordAfter.json.data.role, 'admin');
  });

  it('改令牌后旧令牌不能再换取会话', async () => {
    const session = await loginWithToken(base, 'old-key');
    assert.equal(session, '');
    const fresh = await loginWithToken(base, 'new-key');
    assert.ok(fresh);
  });
});
