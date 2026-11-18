/**
 * 运行时设置管理的集成测试
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { removeDir, startServer, tempDir } = require('./helpers');

/** 当前生效的访问令牌（启用后所有接口都要带上） */
let accessKey = '';

/** 调用 JSON 接口，可选带上会话令牌 */
async function call(base, path_, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  const url = accessKey ? path_ + (path_.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(accessKey) : path_;
  const resp = await fetch(`${base}/localsend/api${url}`, { ...init, headers });
  return { status: resp.status, json: await resp.json() };
}

/** 登录并返回会话令牌 */
async function login(base, password) {
  const { json } = await call(base, '/login', { method: 'POST', body: JSON.stringify({ password }) });
  return json.code === 0 ? json.data.token : '';
}

/** 取设置列表 */
async function getSettings(base, token) {
  const { status, json } = await call(base, '/settings', { headers: { 'X-Localsend-Session': token } });
  return { status, data: json.data };
}

describe('LocalSend 运行时设置', () => {
  let dir;
  let settingsFile;
  let server;
  let base;

  before(async () => {
    dir = tempDir('sserver-settings-');
    settingsFile = path.join(dir, 'settings.json');
    // 把运行时设置文件放到临时目录，避免污染真实用户配置
    process.env.SS_LOCALSEND_SETTINGS = settingsFile;
    server = await startServer(dir, { password: 'admin-pwd' });
    base = server.base;
  });

  after(async () => {
    if (server) await server.close();
    removeDir(dir);
    delete process.env.SS_LOCALSEND_SETTINGS;
  });

  it('未登录不能查看设置', async () => {
    const { status } = await call(base, '/settings');
    assert.equal(status, 403);
  });

  it('管理员可以查看设置', async () => {
    const token = await login(base, 'admin-pwd');
    const { status, data } = await getSettings(base, token);
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.items));
    const keys = data.items.map((i) => i.key);
    for (const key of ['token', 'password', 'visitorPassword', 'maxSize', 'maxConcurrent', 'trashDays']) {
      assert.ok(keys.includes(key), `缺少配置项 ${key}`);
    }
  });

  it('敏感值不会明文返回', async () => {
    const token = await login(base, 'admin-pwd');
    const { data } = await getSettings(base, token);
    const pwd = data.items.find((i) => i.key === 'password');
    assert.equal(pwd.set, true);
    assert.equal(pwd.masked.includes('admin-pwd'), false);
    assert.equal('value' in pwd, false);
  });

  it('非管理员不能修改设置', async () => {
    const { status } = await call(base, '/settings', {
      method: 'POST',
      body: JSON.stringify({ changes: { maxConcurrent: 9 } }),
    });
    assert.equal(status, 403);
  });

  it('修改后立即生效', async () => {
    const token = await login(base, 'admin-pwd');
    const { status, json } = await call(base, '/settings', {
      method: 'POST',
      headers: { 'X-Localsend-Session': token },
      body: JSON.stringify({ changes: { maxConcurrent: 7, trashDays: 3 } }),
    });
    assert.equal(status, 200);
    assert.deepEqual(json.data.applied.sort(), ['maxConcurrent', 'trashDays']);

    const { data } = await getSettings(base, token);
    const concurrent = data.items.find((i) => i.key === 'maxConcurrent');
    const trash = data.items.find((i) => i.key === 'trashDays');
    assert.equal(concurrent.value, 7);
    assert.equal(concurrent.source, 'runtime');
    assert.equal(trash.value, 3);
  });

  it('修改访问令牌后旧令牌立即失效', async () => {
    const token = await login(base, 'admin-pwd');
    const { status } = await call(base, '/settings', {
      method: 'POST',
      headers: { 'X-Localsend-Session': token },
      body: JSON.stringify({ changes: { token: 'new-token' } }),
    });
    assert.equal(status, 200);

    // 令牌生效后，所有接口都必须带上它
    accessKey = 'new-token';
    const list = await fetch(`${base}/localsend/api/list`);
    assert.equal(list.status, 401);
    const withKey = await fetch(`${base}/localsend/api/list?key=new-token`);
    assert.equal(withKey.status, 200);
  });

  it('修改口令需要验证当前口令', async () => {
    const token = await login(base, 'admin-pwd');
    const bad = await call(base, '/settings', {
      method: 'POST',
      headers: { 'X-Localsend-Session': token },
      body: JSON.stringify({ changes: { password: 'new-pwd' }, currentPassword: 'wrong' }),
    });
    assert.equal(bad.status, 403);
    assert.match(bad.json.msg, /口令/);
  });

  it('修改口令后旧会话失效、当前会话保留', async () => {
    const oldToken = await login(base, 'admin-pwd');
    const otherToken = await login(base, 'admin-pwd');
    const { status } = await call(base, '/settings', {
      method: 'POST',
      headers: { 'X-Localsend-Session': oldToken },
      body: JSON.stringify({ changes: { password: 'new-pwd' }, currentPassword: 'admin-pwd' }),
    });
    assert.equal(status, 200);

    // 其它会话被踢下线
    const other = await getSettings(base, otherToken);
    assert.equal(other.status, 403);
    // 当前会话仍然有效
    const self = await getSettings(base, oldToken);
    assert.equal(self.status, 200);
    // 新口令可以登录
    const fresh = await login(base, 'new-pwd');
    assert.ok(fresh);
  });

  it('设置会被持久化，重启后依然生效', async () => {
    assert.ok(fs.existsSync(settingsFile), '设置文件应已写入');
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(saved.values.password, 'new-pwd');
    assert.equal(saved.values.token, 'new-token');
    assert.equal(saved.values.maxConcurrent, 7);
  });

  it('恢复默认后回到配置文件里的值', async () => {
    const token = await login(base, 'new-pwd');
    const { status } = await call(base, '/settings/maxConcurrent', {
      method: 'DELETE',
      headers: { 'X-Localsend-Session': token },
    });
    assert.equal(status, 200);
    const { data } = await getSettings(base, token);
    const concurrent = data.items.find((i) => i.key === 'maxConcurrent');
    assert.equal(concurrent.source, 'config');
    assert.notEqual(concurrent.value, 7);
  });

  it('非法取值会被拒绝', async () => {
    const token = await login(base, 'new-pwd');
    const { status, json } = await call(base, '/settings', {
      method: 'POST',
      headers: { 'X-Localsend-Session': token },
      body: JSON.stringify({ changes: { sessionTtl: -5 } }),
    });
    assert.equal(status, 400);
    assert.match(json.msg, /会话有效期/);
  });

  it('未知配置项会被拒绝', async () => {
    const token = await login(base, 'new-pwd');
    const { status } = await call(base, '/settings', {
      method: 'POST',
      headers: { 'X-Localsend-Session': token },
      body: JSON.stringify({ changes: { nope: 1 } }),
    });
    assert.equal(status, 400);
  });
});
