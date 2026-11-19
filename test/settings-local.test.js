/**
 * 开放模式下的设置写入限制
 *
 * 开放模式（未配置任何口令）下，危险操作按设计对所有人开放，
 * 但「改设置」必须例外：否则局域网内任何人都能设一个管理员口令，
 * 然后以管理员身份删光文件，原使用者反被锁在门外。
 *
 * 规则：开放模式下只接受本机（回环地址）发起的设置写入。
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { getIpCandidates } = require('../dist/lib/utils');
const { startServer, tempDir, removeDir } = require('./helpers');

/** 把 startServer 返回的基地址换成另一个网卡地址 */
function viaLanIp(base, ip) {
  const url = new URL(base);
  return `http://${ip}:${url.port}`;
}

/** 局域网地址是否可用（同机访问自身网卡地址，可能被防火墙拦掉） */
async function lanReachable(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const resp = await fetch(`${url}/localsend/api/session`, { signal: controller.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

describe('开放模式设置写入', () => {
  it('本机（回环）允许修改设置', async () => {
    const dir = tempDir('ls-settings-local-');
    const server = await startServer(dir, {});
    try {
      const resp = await fetch(`${server.base}/localsend/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: { maxConcurrent: 2 } }),
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      assert.equal(json.code, 0);
    } finally {
      await server.close();
      removeDir(dir);
    }
  });

  it('非本机（局域网地址）拒绝修改设置，并给出可操作的提示', async (t) => {
    const lanIp = getIpCandidates()[0]?.address;
    if (!lanIp) return t.skip('本机没有可用的局域网地址');
    const dir = tempDir('ls-settings-remote-');
    const server = await startServer(dir, {});
    try {
      const lanBase = viaLanIp(server.base, lanIp);
      if (!(await lanReachable(lanBase))) return t.skip('无法通过局域网地址访问本机服务（可能被防火墙拦截）');

      const resp = await fetch(`${lanBase}/localsend/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: { password: 'pwned-by-lan-user' } }),
      });
      assert.equal(resp.status, 403);
      const json = await resp.json();
      assert.equal(json.code, 1);
      assert.equal(json.needLocal, true);
      assert.match(json.msg, /本机/);

      // 确认口令没有被写入：仍然是开放模式
      const session = await fetch(`${lanBase}/localsend/api/session`).then((r) => r.json());
      assert.equal(session.data.open, true);
      assert.equal(session.data.hasAdmin, false);

      // 恢复默认设置同样受限
      const del = await fetch(`${lanBase}/localsend/api/settings/maxConcurrent`, { method: 'DELETE' });
      assert.equal(del.status, 403);
    } finally {
      await server.close();
      removeDir(dir);
    }
  });

  it('配好口令之后，远端的匿名写入按普通权限拒绝', async (t) => {
    const lanIp = getIpCandidates()[0]?.address;
    if (!lanIp) return t.skip('本机没有可用的局域网地址');
    const dir = tempDir('ls-settings-admin-');
    const server = await startServer(dir, {});
    try {
      const lanBase = viaLanIp(server.base, lanIp);
      if (!(await lanReachable(lanBase))) return t.skip('无法通过局域网地址访问本机服务（可能被防火墙拦截）');

      // 本机设置管理员口令
      const set = await fetch(`${server.base}/localsend/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: { password: 'admin-pass' } }),
      });
      assert.equal(set.status, 200);

      // 远端匿名再改设置：此时不是开放模式，走普通管理员校验
      const resp = await fetch(`${lanBase}/localsend/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: { maxConcurrent: 1 } }),
      });
      assert.equal(resp.status, 403);
      const json = await resp.json();
      assert.equal(json.needAuth, true);
    } finally {
      await server.close();
      removeDir(dir);
    }
  });
});
