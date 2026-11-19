/**
 * 分片上传的限流与并发预算
 *
 * 背景：分片按「片」发请求，1GB 文件就是 256 个请求。
 * 若与普通接口共用 120 次/分的预算，大文件必然传到一半失败。
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createGuard } = require('../dist/localsend/guard');
const { startServer, tempDir, removeDir } = require('./helpers');

/** 构造一个最小化的请求对象 */
function mockReq({ path = '/api/list', query = {}, headers = {} } = {}) {
  return { path, query, headers, get: (name) => headers[name] };
}

/** 构造一个最小化的响应对象（支持触发事件） */
function mockRes() {
  const listeners = {};
  return {
    statusCode: 200,
    body: '',
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    on(event, cb) {
      (listeners[event] ||= []).push(cb);
      return this;
    },
    emit(event) {
      (listeners[event] || []).forEach((cb) => cb());
      return this;
    },
  };
}

describe('分片限流独立计数', () => {
  it('普通接口被限流后，分片请求仍然放行', () => {
    const guard = createGuard({
      rateLimit: { windowMs: 60_000, max: 2 },
      chunkRateLimit: { windowMs: 60_000, max: 10 },
    });
    const pass = () => {
      let called = false;
      const res = mockRes();
      guard.rateLimit(mockReq(), res, () => {
        called = true;
      });
      return called;
    };
    assert.equal(pass(), true);
    assert.equal(pass(), true);
    assert.equal(pass(), false, '普通接口第 3 次应被限流');

    const passChunk = () => {
      let called = false;
      const res = mockRes();
      guard.rateLimitChunk(mockReq({ path: '/api/chunk/upload' }), res, () => {
        called = true;
      });
      return called;
    };
    for (let i = 0; i < 10; i++) assert.equal(passChunk(), true, `分片第 ${i + 1} 次应放行`);
    assert.equal(passChunk(), false, '分片预算用完后同样要限流');
  });

  it('分片预算默认比普通接口宽', () => {
    const guard = createGuard({});
    const hit = (fn) => {
      let called = false;
      fn(mockReq(), mockRes(), () => {
        called = true;
      });
      return called;
    };
    let general = 0;
    for (let i = 0; i < 200; i++) if (hit(guard.rateLimit)) general += 1;
    let chunk = 0;
    for (let i = 0; i < 200; i++) if (hit(guard.rateLimitChunk)) chunk += 1;
    assert.equal(general, 120, '普通接口默认 120 次/分');
    assert.ok(chunk > general, '分片预算应更宽');
  });
});

describe('分片并发预算', () => {
  it('分片并发按文件并发的 3 倍 + 3 计算', () => {
    const guard = createGuard({ maxConcurrent: 1 });
    // maxConcurrent=1 → 分片预算 6
    const results = [];
    for (let i = 0; i < 8; i++) {
      let called = false;
      guard.limitConcurrentChunk(mockReq(), mockRes(), () => {
        called = true;
      });
      results.push(called);
    }
    assert.equal(results.filter(Boolean).length, 6);
  });

  it('释放后额度可以复用', () => {
    const guard = createGuard({ maxConcurrent: 1 });
    const res = mockRes();
    let called = false;
    guard.limitConcurrentChunk(mockReq(), res, () => {
      called = true;
    });
    assert.equal(called, true);
    res.emit('finish');
    let again = false;
    guard.limitConcurrentChunk(mockReq(), mockRes(), () => {
      again = true;
    });
    assert.equal(again, true);
  });
});

describe('接口层面：分片请求不吃普通接口预算', () => {
  it('普通接口 429 之后，chunk/init 仍然可用', async () => {
    const dir = tempDir('ls-rate-');
    const server = await startServer(dir, { rateLimit: { windowMs: 60_000, max: 3 } });
    try {
      const listStatuses = [];
      for (let i = 0; i < 5; i++) {
        const resp = await fetch(`${server.base}/localsend/api/list`);
        listStatuses.push(resp.status);
      }
      assert.deepEqual(listStatuses.slice(0, 3), [200, 200, 200]);
      assert.equal(listStatuses[4], 429, '第 5 次普通请求应被限流');

      // 分片初始化使用独立预算，不应被上面的 429 牵连
      for (let i = 0; i < 5; i++) {
        const resp = await fetch(`${server.base}/localsend/api/chunk/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `big-${i}.bin`, size: 8 * 1024 * 1024, chunkSize: 4 * 1024 * 1024 }),
        });
        assert.equal(resp.status, 200, `第 ${i + 1} 次 chunk/init 应放行`);
      }
    } finally {
      await server.close();
      removeDir(dir);
    }
  });
});
