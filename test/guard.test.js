/**
 * 访问防护（令牌 / 频率限制 / 并发限制）的单元测试
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createGuard } = require('../dist/lib/localsend-guard');

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
  it('未配置令牌时直接放行', () => {
    const guard = createGuard({});
    let called = false;
    guard.requireToken(mockReq(), mockRes(), () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('令牌正确时放行', () => {
    const guard = createGuard({ token: 'secret' });
    let called = false;
    guard.requireToken(mockReq({ query: { key: 'secret' } }), mockRes(), () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('令牌错误时接口返回 401 JSON', () => {
    const guard = createGuard({ token: 'secret' });
    const res = mockRes();
    guard.requireToken(mockReq({ path: '/api/list', query: { key: 'wrong' } }), res, () => {});
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 1);
  });

  it('令牌错误时页面返回 HTML 提示', () => {
    const guard = createGuard({ token: 'secret' });
    const res = mockRes();
    guard.requireToken(mockReq({ path: '/', query: {} }), res, () => {});
    assert.equal(res.statusCode, 401);
    assert.match(String(res.body), /访问令牌/);
  });

  it('支持通过请求头携带令牌', () => {
    const guard = createGuard({ token: 'secret' });
    let called = false;
    guard.requireToken(mockReq({ headers: { 'X-Localsend-Key': 'secret' } }), mockRes(), () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('静态资源不校验令牌', () => {
    const guard = createGuard({ token: 'secret' });
    let called = false;
    guard.requireToken(mockReq({ path: '/style.css' }), mockRes(), () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('接口路径不能用静态后缀绕过校验', () => {
    const guard = createGuard({ token: 'secret' });
    const res = mockRes();
    guard.requireToken(mockReq({ path: '/api/download/a.css' }), res, () => {});
    assert.equal(res.statusCode, 401);
  });
});

describe('频率限制', () => {
  it('超过窗口内上限后返回 429', () => {
    const guard = createGuard({ rateLimit: { windowMs: 60_000, max: 2 } });
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
    const guard = createGuard({ rateLimit: { windowMs: 60_000, max: 1 } });
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
});

describe('并发限制', () => {
  it('超过并发上限后返回 429，结束后释放', () => {
    const guard = createGuard({ maxConcurrent: 2 });
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
