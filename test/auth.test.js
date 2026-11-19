/**
 * 身份与权限的单元测试
 *
 * 口令与令牌都走摘要：客户端用服务端公开的盐值派生出摘要后提交，
 * 这里用 Node 的 crypto 复现同样的计算。
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');

const { canManage, canWrite, createAuth } = require('../dist/localsend/auth');

/** 用服务端公开的盐值算出摘要 */
function digestOf(auth, kind, secret) {
  const info = auth.secrets().find((item) => item.kind === kind);
  if (!info) return '';
  return crypto.pbkdf2Sync(String(secret), Buffer.from(info.salt, 'hex'), info.iterations, 32, 'sha256').toString('hex');
}

describe('身份会话', () => {
  it('未配置口令时为开放模式', () => {
    const auth = createAuth({});
    assert.equal(auth.open, true);
    assert.equal(auth.hasAdmin, false);
    assert.equal(auth.roleOf(''), 'open');
    assert.equal(canManage('open'), true);
    assert.equal(canWrite('open'), true);
  });

  it('配置管理员口令后未登录为只读', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    assert.equal(auth.open, false);
    assert.equal(auth.hasAdmin, true);
    assert.equal(auth.roleOf(''), 'guest');
    assert.equal(canManage('guest'), false);
    // 没有配置访客口令时，未登录的人也可以上传下载
    assert.equal(canWrite('guest'), true);
    assert.equal(canWrite('guest', false), true);
    // 配置了访客口令后，未登录的人必须先输入口令
    assert.equal(canWrite('guest', true), false);
  });

  it('口令摘要正确时获得管理员角色', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    const session = auth.login({ password: digestOf(auth, 'password', 'admin-pwd') });
    assert.ok(session);
    assert.equal(session.role, 'admin');
    assert.equal(session.via, 'password');
    assert.equal(auth.roleOf(session.token), 'admin');
    assert.equal(canManage('admin'), true);
    assert.equal(canWrite('admin'), true);
  });

  it('口令摘要错误时无法登录', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    assert.equal(auth.login({ password: digestOf(auth, 'password', 'wrong') }), null);
    // 明文口令不再被接受：服务端只认摘要
    assert.equal(auth.login({ password: 'admin-pwd' }), null);
    assert.equal(auth.login({}), null);
  });

  it('访客口令登录后只能写不能管理', () => {
    const auth = createAuth({ password: 'admin-pwd', visitorPassword: 'guest-pwd' });
    const session = auth.login({ visitorPassword: digestOf(auth, 'visitorPassword', 'guest-pwd') });
    assert.ok(session);
    assert.equal(session.role, 'visitor');
    assert.equal(auth.roleOf(session.token), 'visitor');
    assert.equal(canManage('visitor'), false);
    assert.equal(canWrite('visitor'), true);
    assert.equal(canWrite('visitor', true), true);
  });

  it('注销后会话立即失效', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    const session = auth.login({ password: digestOf(auth, 'password', 'admin-pwd') });
    assert.equal(auth.roleOf(session.token), 'admin');
    assert.equal(auth.logout(session.token), true);
    assert.equal(auth.roleOf(session.token), 'guest');
    assert.equal(auth.logout(session.token), false);
  });

  it('过期会话被清理', () => {
    const auth = createAuth({ password: 'admin-pwd', sessionTtl: -1000 });
    const session = auth.login({ password: digestOf(auth, 'password', 'admin-pwd') });
    // 有效期为负，等同于已过期
    assert.equal(auth.get(session.token), null);
    assert.equal(auth.roleOf(session.token), 'guest');
  });

  it('不同会话令牌互相独立', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    const digest = digestOf(auth, 'password', 'admin-pwd');
    const a = auth.login({ password: digest });
    const b = auth.login({ password: digest });
    assert.notEqual(a.token, b.token);
    assert.equal(auth.roleOf(a.token), 'admin');
    assert.equal(auth.roleOf(b.token), 'admin');
  });

  it('会话令牌不可预测', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    const digest = digestOf(auth, 'password', 'admin-pwd');
    const tokens = new Set();
    for (let i = 0; i < 20; i++) tokens.add(auth.login({ password: digest }).token);
    assert.equal(tokens.size, 20);
    for (const token of tokens) assert.ok(token.length >= 30);
  });

  it('stop 后不再维护定时器', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    auth.stop();
    assert.equal(auth.roleOf(''), 'guest');
  });
});

describe('访问令牌', () => {
  it('令牌摘要正确时换取会话', () => {
    const auth = createAuth({ token: 'secret-key' });
    assert.equal(auth.hasToken, true);
    const session = auth.loginByToken(digestOf(auth, 'token', 'secret-key'));
    assert.ok(session);
    // 没有配置任何口令时，令牌等同管理员
    assert.equal(session.role, 'open');
    assert.equal(session.via, 'token');
    assert.equal(auth.roleOf(session.token), 'open');
  });

  it('令牌摘要错误时无法换取会话', () => {
    const auth = createAuth({ token: 'secret-key' });
    assert.equal(auth.loginByToken(digestOf(auth, 'token', 'wrong')), null);
    assert.equal(auth.loginByToken('secret-key'), null);
  });

  it('配置了口令时，令牌只换到访客级别的权限', () => {
    const auth = createAuth({ token: 'secret-key', password: 'admin-pwd' });
    const session = auth.loginByToken(digestOf(auth, 'token', 'secret-key'));
    assert.ok(session);
    assert.equal(session.role, 'guest');
    assert.equal(canManage(session.role), false);
  });

  it('令牌变更只作废用令牌换来的会话', () => {
    const auth = createAuth({ token: 'secret-key', password: 'admin-pwd' });
    const byToken = auth.loginByToken(digestOf(auth, 'token', 'secret-key'));
    const byPassword = auth.login({ password: digestOf(auth, 'password', 'admin-pwd') });
    assert.ok(byToken && byPassword);
    auth.update({ token: 'new-key' });
    // 令牌会话失效
    assert.equal(auth.get(byToken.token), null);
    // 口令登录的会话仍然有效
    assert.ok(auth.get(byPassword.token));
  });

  it('口令变更会让此前所有会话失效', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    const session = auth.login({ password: digestOf(auth, 'password', 'admin-pwd') });
    assert.ok(session);
    auth.update({ password: 'new-pwd' });
    assert.equal(auth.get(session.token), null);
    // 新口令可以登录
    const next = auth.login({ password: digestOf(auth, 'password', 'new-pwd') });
    assert.ok(next);
    assert.equal(next.role, 'admin');
  });

  it('明文口令只在校验时使用，不进会话', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    assert.equal(auth.verifyPlain('admin-pwd'), 'password');
    assert.equal(auth.verifyPlain('nope'), null);
    assert.equal(auth.plainRole('admin-pwd'), 'admin');
    assert.equal(auth.plainRole('nope'), null);
  });
});
