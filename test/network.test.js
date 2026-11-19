/**
 * 候选访问地址的排序与接口测试
 *
 * 背景：手机扫码打不开的第一大原因，是主机有多张网卡
 * （WSL / Docker / VPN / 虚拟机）而服务端取错了地址。
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { getIpCandidates, isLoopbackAddress, isPrivateAddress, rankIpCandidates } = require('../dist/lib/utils');
const { startServer, tempDir, removeDir } = require('./helpers');

describe('地址候选排序', () => {
  it('家用网段优先于 Docker / WSL 常用的 172.16-31', () => {
    const ranked = rankIpCandidates([
      { address: '172.24.96.1', iface: 'vEthernet (WSL)' },
      { address: '192.168.1.20', iface: 'WLAN' },
      { address: '10.8.0.6', iface: 'Ethernet' },
    ]);
    assert.deepEqual(
      ranked.map((item) => item.address),
      ['192.168.1.20', '10.8.0.6', '172.24.96.1'],
    );
  });

  it('同样私网段时，虚拟网卡排在物理网卡之后', () => {
    const ranked = rankIpCandidates([
      { address: '192.168.56.1', iface: 'VirtualBox Host-Only Network' },
      { address: '192.168.1.30', iface: 'WLAN' },
    ]);
    assert.equal(ranked[0].address, '192.168.1.30');
  });

  it('169.254（未拿到 DHCP）排在最后', () => {
    const ranked = rankIpCandidates([
      { address: '169.254.10.3', iface: 'Ethernet' },
      { address: '172.20.0.5', iface: 'Docker' },
    ]);
    assert.equal(ranked[0].address, '172.20.0.5');
  });

  it('排序稳定：同等优先级按地址字典序', () => {
    const ranked = rankIpCandidates([
      { address: '192.168.1.9', iface: 'WLAN' },
      { address: '192.168.1.10', iface: 'WLAN' },
    ]);
    assert.deepEqual(
      ranked.map((item) => item.address),
      ['192.168.1.10', '192.168.1.9'],
    );
  });

  it('只返回非回环的 IPv4 地址', () => {
    const list = getIpCandidates();
    assert.ok(Array.isArray(list));
    for (const item of list) {
      assert.equal(typeof item.address, 'string');
      assert.equal(typeof item.iface, 'string');
      assert.ok(!item.address.startsWith('127.'));
      assert.ok(item.address.includes('.'));
    }
  });
});

describe('地址分类', () => {
  it('识别回环地址', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('192.168.1.2'), false);
  });

  it('识别私网地址', () => {
    assert.equal(isPrivateAddress('192.168.1.2'), true);
    assert.equal(isPrivateAddress('10.0.0.2'), true);
    assert.equal(isPrivateAddress('172.16.0.2'), true);
    assert.equal(isPrivateAddress('172.32.0.2'), false);
    assert.equal(isPrivateAddress('8.8.8.8'), false);
    assert.equal(isPrivateAddress(''), false);
  });
});

describe('GET /localsend/api/network', () => {
  it('免鉴权即可拿到候选地址，形状稳定', async () => {
    const dir = tempDir('ls-network-');
    const server = await startServer(dir, { token: 'secret-token' });
    try {
      const resp = await fetch(`${server.base}/localsend/api/network`);
      assert.equal(resp.status, 200);
      const json = await resp.json();
      assert.equal(json.code, 0);
      const data = json.data;
      assert.ok(Array.isArray(data.addresses));
      for (const item of data.addresses) {
        assert.equal(typeof item.address, 'string');
        assert.equal(typeof item.iface, 'string');
      }
      assert.equal(typeof data.suggested, 'string');
      assert.equal(typeof data.loopback, 'boolean');
      // 从回环地址发起的请求应被识别为 loopback，避免把 127.0.0.1 建议给手机
      assert.equal(data.loopback, true);
    } finally {
      await server.close();
      removeDir(dir);
    }
  });
});
