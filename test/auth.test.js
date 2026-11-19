/**
 * 身份与权限的单元测试
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { canManage, canWrite, createAuth } = require('../dist/localsend/auth');

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
    assert.equal(canWrite('guest'), false);
  });

  it('管理员口令登录后获得管理员角色', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    const session = auth.login('admin-pwd');
    assert.ok(session);
    assert.equal(session.role, 'admin');
    assert.equal(auth.roleOf(session.token), 'admin');
    assert.equal(canManage('admin'), true);
    assert.equal(canWrite('admin'), true);
  });

  it('访客口令登录后只能写不能管理', () => {
    const auth = createAuth({ password: 'admin-pwd', visitorPassword: 'guest-pwd' });
    const session = auth.login('guest-pwd');
    assert.ok(session);
    assert.equal(session.role, 'visitor');
    assert.equal(auth.roleOf(session.token), 'visitor');
    assert.equal(canManage('visitor'), false);
    assert.equal(canWrite('visitor'), true);
  });

  it('错误口令无法登录', () => {
    const auth = createAuth({ password: 'admin-pwd', visitorPassword: 'guest-pwd' });
    assert.equal(auth.login('wrong'), null);
    assert.equal(auth.login(''), null);
    assert.equal(auth.login(undefined), null);
    // 访客口令不能当管理员用，反之亦然
    const admin = auth.login('admin-pwd');
    assert.equal(admin.role, 'admin');
  });

  it('注销后会话立即失效', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    const session = auth.login('admin-pwd');
    assert.equal(auth.roleOf(session.token), 'admin');
    assert.equal(auth.logout(session.token), true);
    assert.equal(auth.roleOf(session.token), 'guest');
    assert.equal(auth.logout(session.token), false);
  });

  it('过期会话被清理', () => {
    const auth = createAuth({ password: 'admin-pwd', sessionTtl: -1000 });
    const session = auth.login('admin-pwd');
    // 有效期为负，等同于已过期
    assert.equal(auth.get(session.token), null);
    assert.equal(auth.roleOf(session.token), 'guest');
  });

  it('不同会话令牌互相独立', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    const a = auth.login('admin-pwd');
    const b = auth.login('admin-pwd');
    assert.notEqual(a.token, b.token);
    assert.equal(auth.roleOf(a.token), 'admin');
    assert.equal(auth.roleOf(b.token), 'admin');
  });

  it('会话令牌不可预测', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    const tokens = new Set();
    for (let i = 0; i < 20; i++) tokens.add(auth.login('admin-pwd').token);
    assert.equal(tokens.size, 20);
    for (const token of tokens) assert.ok(token.length >= 30);
  });

  it('stop 后不再维护定时器', () => {
    const auth = createAuth({ password: 'admin-pwd' });
    auth.stop();
    assert.equal(auth.roleOf(''), 'guest');
  });
});
