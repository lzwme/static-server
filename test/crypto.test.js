/**
 * 前端摘要算法的测试
 *
 * 前端 crypto.js 是纯 JS 实现（局域网 http 下没有 WebCrypto），
 * 必须与服务端 secret.ts（Node 的 crypto.pbkdf2Sync）算出完全一样的摘要，
 * 否则浏览器与服务端就对不上账。这里直接与 Node 的实现对照。
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');

const { pbkdf2Hex, sha256Hex } = require('../src/localsend/client/crypto.js');

/** 服务端（Node）的摘要 */
function nodeDigest(secret, saltHex, iterations) {
  return crypto.pbkdf2Sync(String(secret), Buffer.from(saltHex, 'hex'), iterations, 32, 'sha256').toString('hex');
}

describe('前端摘要算法', () => {
  it('SHA-256 与 Node 一致', () => {
    for (const text of ['abc', '', 'LocalSend', '口令与 emoji 😀']) {
      assert.equal(sha256Hex(text), crypto.createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });

  it('PBKDF2 与 Node 一致', () => {
    const cases = ['admin-pwd', 'guest-pwd', '口令测试 123', 'a', '😀 emoji 密码', ''];
    for (const secret of cases) {
      for (const iterations of [1, 1000, 10000]) {
        const salt = crypto.randomBytes(16).toString('hex');
        assert.equal(pbkdf2Hex(secret, salt, iterations), nodeDigest(secret, salt, iterations));
      }
    }
  });

  it('盐值不同时摘要不同', () => {
    const saltA = crypto.randomBytes(16).toString('hex');
    const saltB = crypto.randomBytes(16).toString('hex');
    assert.notEqual(pbkdf2Hex('same-pwd', saltA, 10000), pbkdf2Hex('same-pwd', saltB, 10000));
  });

  it('迭代次数不同时摘要不同', () => {
    const salt = crypto.randomBytes(16).toString('hex');
    assert.notEqual(pbkdf2Hex('same-pwd', salt, 1000), pbkdf2Hex('same-pwd', salt, 10000));
  });
});
