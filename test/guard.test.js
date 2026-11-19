/**
 * 访问防护（令牌 / 频率限制 / 并发限制）的单元测试
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createGuard } = require('../dist/localsend/guard');

/** 构造一个最小化的请求对象 */
function mockReq({ path = '/api/list', query = {}, headers = {} } = {}) {
  return { path, query, headers, get: (name) => headers[name] };
}

/** 构造一个最小化的响应对象（支持触发事件） */
function mockRes() {
  const listeners = {};
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    status(code) {
      this.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    send(data) {
      this.body = data;
      return this;
    },
    on(event, cb) {
      (listeners[event] ||= []).push(cb);
      return this;
    },
    /** 手动触发事件，模拟请求结束 */
    emit(event) {
      (listeners[event] || []).forEach((cb) => cb());
      return this;
    },
  };
  return res;
}

describe('访问令牌', () => {
  /** 构造一个启用了令牌的防护：令牌摘要为 'digest' */
  function guardWithToken() {
    return createGuard({
      hasToken: () => true,
      verifyKey: (digest) => digest === 'digest',
      verifySession: (token) => token === 'session-ok',
    });
  }

  it('未配置令牌时直接放行', () => {
    const guard = createGuard({});
    let called = false;
    guard.requireAuth(mockReq(), mockRes(), () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('请求头里的令牌摘要正确时放行', () => {
    const guard = guardWithToken();
    let called = false;
    guard.requireAuth(mockReq({ headers: { 'X-Localsend-Key': 'digest' } }), mockRes(), () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('会话令牌有效时放行', () => {
    const guard = guardWithToken();
    let called = false;
    guard.requireAuth(mockReq({ headers: { 'X-Localsend-Session': 'session-ok' } }), mockRes(), () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('SSE 等场景可以用查询参数带会话', () => {
    const guard = guardWithToken();
    let called = false;
    guard.requireAuth(mockReq({ query: { session: 'session-ok' } }), mockRes(), () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('令牌错误时接口返回 401 JSON', () => {
    const guard = guardWithToken();
    const res = mockRes();
    guard.requireAuth(mockReq({ path: '/api/list', headers: { 'X-Localsend-Key': 'wrong' } }), res, () => {});
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 1);
    assert.equal(res.body.needToken, true);
  });

  it('页面与静态资源照常放行，便于前端提示输入令牌', () => {
    const guard = guardWithToken();
    for (const path of ['/', '/style.css', '/app.js', '/crypto.js']) {
      let called = false;
      guard.requireAuth(mockReq({ path }), mockRes(), () => {
        called = true;
      });
      assert.equal(called, true, path + ' 应该放行');
    }
  });

  it('接口路径不能用静态后缀绕过校验', () => {
    const guard = guardWithToken();
    const res = mockRes();
    guard.requireAuth(mockReq({ path: '/api/download/a.css' }), res, () => {});
    assert.equal(res.statusCode, 401);
  });

  it('带了服务端不认的会话时提示会话失效，而不是缺令牌', () => {
    // 客户端要靠这个区分弹「重新登录」还是弹「输入访问令牌」
    const guard = guardWithToken();
    const res = mockRes();
    guard.requireAuth(mockReq({ headers: { 'X-Localsend-Session': 'stale' } }), res, () => {});
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.needLogin, true);
    assert.equal(res.body.needToken, undefined);
  });

  it('没配置令牌时带着失效会话也放行，按访客口径处理', () => {
    // 没配令牌时接口不设大门锁：一次会话过期不该把整个页面锁死
    const guard = createGuard({ verifySession: () => false });
    let called = false;
    const res = mockRes();
    guard.requireAuth(mockReq({ headers: { 'X-Localsend-Session': 'stale' } }), res, () => {
      called = true;
    });
    assert.equal(called, true);
    assert.equal(res.statusCode, 200);
  });
});

describe('频率限制', () => {
  it('超过窗口内上限后返回 429', () => {
    const guard = createGuard({ rateLimit: { windowMs: 60_000, max: 2 }, trustProxy: true });
    const res = mockRes();
    let allowed = 0;
    for (let i = 0; i < 4; i++) {
      guard.rateLimit(mockReq({ headers: { 'x-forwarded-for': '1.1.1.1' } }), res, () => {
        allowed += 1;
      });
    }
    assert.equal(allowed, 2);
    assert.equal(res.statusCode, 429);
  });

  it('不同 IP 互不影响', () => {
    const guard = createGuard({ rateLimit: { windowMs: 60_000, max: 1 }, trustProxy: true });
    const res = mockRes();
    let allowed = 0;
    guard.rateLimit(mockReq({ headers: { 'x-forwarded-for': '2.2.2.2' } }), res, () => {
      allowed += 1;
    });
    guard.rateLimit(mockReq({ headers: { 'x-forwarded-for': '3.3.3.3' } }), res, () => {
      allowed += 1;
    });
    assert.equal(allowed, 2);
  });

  it('默认不信任伪造的 X-Forwarded-For', () => {
    const guard = createGuard({ rateLimit: { windowMs: 60_000, max: 1 } });
    const res = mockRes();
    let allowed = 0;
    guard.rateLimit(mockReq({ headers: { 'x-forwarded-for': '9.9.9.9' } }), res, () => {
      allowed += 1;
    });
    guard.rateLimit(mockReq({ headers: { 'x-forwarded-for': '8.8.8.8' } }), res, () => {
      allowed += 1;
    });
    // 两次请求都来自同一个（未指定）socket，第二次应被限流
    assert.equal(allowed, 1);
  });
});

describe('并发限制', () => {
  it('超过并发上限后返回 429，结束后释放', () => {
    const guard = createGuard({ maxConcurrent: 2, trustProxy: true });
    const req = mockReq({ headers: { 'x-forwarded-for': '4.4.4.4' } });
    let allowed = 0;
    const handlers = [];
    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      handlers.push(res);
      guard.limitConcurrent(req, res, () => {
        allowed += 1;
      });
    }
    assert.equal(allowed, 2);
    // 请求结束后释放名额
    handlers[0].emit('finish');
    const res = mockRes();
    let again = 0;
    guard.limitConcurrent(req, res, () => {
      again += 1;
    });
    assert.equal(again, 1);
  });
});
