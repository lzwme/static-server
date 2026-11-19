/**
 * 审计日志与运行指标
 *
 * 目标：能回答「谁在什么时候删了什么」「为什么大家传不上去」，
 * 而不是只有一条启动日志。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { createAuditLog } = require('../dist/localsend/audit');
const { createMetrics } = require('../dist/localsend/metrics');
const { createGuard } = require('../dist/localsend/guard');
const { startServer, tempDir, removeDir, upload, login } = require('./helpers');

describe('审计日志文件', () => {
  it('追加写入，recent 按从新到旧返回', () => {
    const dir = tempDir('ls-audit-');
    const log = createAuditLog({ file: path.join(dir, 'audit.log') });
    try {
      log.record({ ip: '10.0.0.2', role: 'admin', action: 'file.delete', target: 'a.txt' });
      log.record({ ip: '10.0.0.3', role: 'visitor', action: 'share.create', target: '1 个文件' });
      const recent = log.recent(10);
      assert.equal(recent.length, 2);
      assert.equal(recent[0].action, 'share.create', '最新的在最前');
      assert.equal(recent[1].action, 'file.delete');
      assert.equal(recent[1].target, 'a.txt');
      assert.equal(recent[1].ip, '10.0.0.2');
      assert.equal(typeof recent[1].ts, 'number');
    } finally {
      removeDir(dir);
    }
  });

  it('超过大小上限时轮转，旧内容进 .1', () => {
    const dir = tempDir('ls-audit-rotate-');
    const file = path.join(dir, 'audit.log');
    const log = createAuditLog({ file, maxBytes: 200 });
    try {
      for (let i = 0; i < 10; i++) log.record({ ip: '10.0.0.9', role: 'admin', action: 'file.delete', target: `f-${i}.txt` });
      assert.ok(fs.existsSync(`${file}.1`), '应生成轮转文件');
      // 当前文件只保留轮转之后写入的记录
      const recent = log.recent(100);
      assert.ok(recent.length > 0 && recent.length < 10);
      assert.equal(recent[0].target, 'f-9.txt');
    } finally {
      removeDir(dir);
    }
  });

  it('损坏的行被跳过，不影响其它记录', () => {
    const dir = tempDir('ls-audit-broken-');
    const file = path.join(dir, 'audit.log');
    const log = createAuditLog({ file });
    try {
      log.record({ ip: '1.1.1.1', role: 'admin', action: 'file.delete', target: 'ok.txt' });
      fs.appendFileSync(file, '{ this is not json\n');
      log.record({ ip: '1.1.1.2', role: 'admin', action: 'file.rename', target: 'b.txt' });
      const recent = log.recent(10);
      assert.equal(recent.length, 2);
      assert.equal(recent[0].target, 'b.txt');
      assert.equal(recent[1].target, 'ok.txt');
    } finally {
      removeDir(dir);
    }
  });

  it('超长 target 会被截断', () => {
    const dir = tempDir('ls-audit-long-');
    const log = createAuditLog({ file: path.join(dir, 'audit.log') });
    try {
      log.record({ ip: '1.1.1.1', role: 'admin', action: 'file.delete', target: 'x'.repeat(2000) });
      assert.equal(log.recent(1)[0].target.length, 500);
    } finally {
      removeDir(dir);
    }
  });
});

describe('指标收集', () => {
  it('计数与耗时分位', () => {
    const metrics = createMetrics();
    metrics.inc('upload.file');
    metrics.inc('upload.file', 2);
    for (const ms of [10, 20, 30, 40, 100]) metrics.observe('merge.ms', ms);
    const snap = metrics.snapshot();
    assert.equal(snap.counters['upload.file'], 3);
    assert.equal(snap.timers['merge.ms'].count, 5);
    assert.equal(snap.timers['merge.ms'].max, 100);
    assert.ok(snap.timers['merge.ms'].p50 >= 20 && snap.timers['merge.ms'].p50 <= 40);
    assert.equal(snap.timers['merge.ms'].p95, 100);
  });

  it('采样数量有上限，内存不会无限增长', () => {
    const metrics = createMetrics();
    for (let i = 0; i < 500; i++) metrics.observe('x', i);
    assert.equal(metrics.snapshot().timers.x.count, 200);
  });

  it('触发限流时会回调（用于计数与告警）', () => {
    let hits = 0;
    const guard = createGuard({ rateLimit: { windowMs: 60_000, max: 1 }, onRateLimited: () => (hits += 1) });
    const req = { path: '/api/list', query: {}, headers: {}, get: () => undefined };
    const res = { status() { return this; }, json() {} };
    guard.rateLimit(req, res, () => {});
    guard.rateLimit(req, res, () => {});
    assert.equal(hits, 1);
    assert.equal(guard.stats().rateLimited, 1);
  });
});

describe('审计与指标接口', () => {
  it('删除文件后能在审计里看到动作、目标与角色', async () => {
    const dir = tempDir('ls-audit-api-');
    // 审计日志放在存储目录之外，避免自己出现在文件列表/配额里
    const auditFile = path.join(tempDir('ls-audit-home-'), 'audit.log');
    const prev = process.env.SS_LOCALSEND_AUDIT;
    process.env.SS_LOCALSEND_AUDIT = auditFile;
    const server = await startServer(dir, {});
    try {
      await upload(server.base, 'secret.txt', 'x');
      const del = await fetch(`${server.base}/localsend/api/delete/secret.txt`, { method: 'DELETE' });
      assert.equal(del.status, 200);

      const resp = await fetch(`${server.base}/localsend/api/audit?limit=10`);
      assert.equal(resp.status, 200);
      const json = await resp.json();
      assert.equal(json.code, 0);
      assert.equal(json.data.file, auditFile);
      const entry = json.data.items.find((item) => item.action === 'file.delete');
      assert.ok(entry, '应记录删除动作');
      assert.equal(entry.target, 'secret.txt');
      assert.equal(entry.role, 'open');
      // 上传也会记一条概要
      assert.ok(json.data.items.some((item) => item.action === 'file.upload'));
    } finally {
      await server.close();
      removeDir(dir);
      if (prev === undefined) delete process.env.SS_LOCALSEND_AUDIT;
      else process.env.SS_LOCALSEND_AUDIT = prev;
    }
  });

  it('非管理员读不到审计与指标', async () => {
    const dir = tempDir('ls-audit-auth-');
    const auditFile = path.join(tempDir('ls-audit-home2-'), 'audit.log');
    const prev = process.env.SS_LOCALSEND_AUDIT;
    process.env.SS_LOCALSEND_AUDIT = auditFile;
    const server = await startServer(dir, { password: 'admin-pwd' });
    try {
      const auditResp = await fetch(`${server.base}/localsend/api/audit`);
      assert.equal(auditResp.status, 403, '未登录不能读审计');
      const statsResp = await fetch(`${server.base}/localsend/api/stats`);
      assert.equal(statsResp.status, 403, '未登录不能读指标');

      const session = await login(server.base, 'admin-pwd');
      const adminAudit = await fetch(`${server.base}/localsend/api/audit`, { headers: { 'X-Localsend-Session': session } });
      assert.equal(adminAudit.status, 200);
      const adminStats = await fetch(`${server.base}/localsend/api/stats`, { headers: { 'X-Localsend-Session': session } });
      assert.equal(adminStats.status, 200);
    } finally {
      await server.close();
      removeDir(dir);
      if (prev === undefined) delete process.env.SS_LOCALSEND_AUDIT;
      else process.env.SS_LOCALSEND_AUDIT = prev;
    }
  });

  it('指标包含上传、合并与缓存命中情况', async () => {
    const dir = tempDir('ls-stats-');
    const auditFile = path.join(tempDir('ls-audit-home3-'), 'audit.log');
    const prev = process.env.SS_LOCALSEND_AUDIT;
    process.env.SS_LOCALSEND_AUDIT = auditFile;
    const server = await startServer(dir, {});
    try {
      await upload(server.base, 'a.txt', 'hello');
      // 分片上传 + 合并
      const chunkSize = 64 * 1024;
      const size = chunkSize * 2;
      const init = await fetch(`${server.base}/localsend/api/chunk/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'big.bin', size, chunkSize }),
      }).then((r) => r.json());
      for (let i = 0; i < 2; i++) {
        const fd = new FormData();
        fd.append('chunk', new Blob([Buffer.alloc(chunkSize, i + 1)]), `chunk-${i}`);
        await fetch(`${server.base}/localsend/api/chunk/upload?uploadId=${init.data.uploadId}&index=${i}`, { method: 'POST', body: fd });
      }
      await fetch(`${server.base}/localsend/api/chunk/merge?uploadId=${init.data.uploadId}`, { method: 'POST' });

      // 读两次列表，制造一次缓存命中
      await fetch(`${server.base}/localsend/api/list`);
      await fetch(`${server.base}/localsend/api/list`);

      const stats = await fetch(`${server.base}/localsend/api/stats`).then((r) => r.json());
      assert.equal(stats.code, 0);
      assert.ok(stats.data.counters['upload.file'] >= 2);
      assert.ok(stats.data.counters['merge.ok'] >= 1);
      assert.ok(stats.data.timers['merge.ms'].count >= 1);
      assert.ok(stats.data.cache.hits >= 1);
      assert.equal(stats.data.files, 2);
      assert.equal(typeof stats.data.uptime, 'number');
      assert.equal(stats.data.audit.file, auditFile);
    } finally {
      await server.close();
      removeDir(dir);
      if (prev === undefined) delete process.env.SS_LOCALSEND_AUDIT;
      else process.env.SS_LOCALSEND_AUDIT = prev;
    }
  });
});
