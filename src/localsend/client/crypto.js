/*
 * LocalSend 前端摘要算法
 *
 * 口令与访问令牌都不再以明文提交：浏览器用服务端公开的盐值派生出摘要，
 * 服务端只比对摘要。摘要算法必须与服务端完全一致，
 * 这里实现的是 PBKDF2-HMAC-SHA256（salt 由服务端给出，迭代次数也由服务端指定）：
 *
 *   摘要 = PBKDF2-HMAC-SHA256(口令, 盐值, 迭代次数, 32 字节)
 *
 * 为什么不用 window.crypto.subtle：
 * 局域网工具通常通过 http://192.168.x.x 访问，不是安全上下文，
 * SubtleCrypto 在这种情况下不可用，只能自带一份实现。
 */
(function (global) {
  'use strict';

  /** SHA-256 轮常量 */
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  /** 循环右移 */
  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  /** 连接多个字节数组 */
  function concat() {
    var lists = [];
    var total = 0;
    for (var i = 0; i < arguments.length; i++) {
      lists.push(arguments[i]);
      total += arguments[i].length;
    }
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < lists.length; j++) {
      out.set(lists[j], offset);
      offset += lists[j].length;
    }
    return out;
  }

  /** 字符串转 UTF-8 字节（与 Node 的 Buffer.from(str, 'utf8') 一致） */
  function utf8(str) {
    var text = String(str ?? '');
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        var low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          var point = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          out.push(
            0xf0 | (point >> 18),
            0x80 | ((point >> 12) & 0x3f),
            0x80 | ((point >> 6) & 0x3f),
            0x80 | (point & 0x3f),
          );
          i++;
        } else {
          // 落单的代理项：与 Node 一致地替换成 U+FFFD
          out.push(0xef, 0xbf, 0xbd);
        }
      } else if (code >= 0xd800 && code <= 0xdfff) {
        out.push(0xef, 0xbf, 0xbd);
      } else {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  /** 十六进制字符串转字节 */
  function fromHex(hex) {
    var text = String(hex || '');
    var out = new Uint8Array(Math.floor(text.length / 2));
    for (var i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16);
    return out;
  }

  /** 字节转十六进制字符串 */
  function toHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var value = bytes[i].toString(16);
      out += value.length < 2 ? '0' + value : value;
    }
    return out;
  }

  /** SHA-256 摘要 */
  function sha256(msg) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = msg.length;
    // 末尾追加 0x80，再补 0 到 56 的倍数，最后追加 8 字节长度
    var total = len + 1;
    var padLen = (56 - (total % 64) + 64) % 64;
    var padded = new Uint8Array(total + padLen + 8);
    padded.set(msg);
    padded[len] = 0x80;
    // 长度按比特计算（64 位大端）：这里只用到低 32 位，高 32 位对超大输入才有意义
    var bits = len * 8;
    var high = Math.floor(bits / 0x100000000);
    var low = bits >>> 0;
    var tail = total + padLen;
    padded[tail] = (high >>> 24) & 0xff;
    padded[tail + 1] = (high >>> 16) & 0xff;
    padded[tail + 2] = (high >>> 8) & 0xff;
    padded[tail + 3] = high & 0xff;
    padded[tail + 4] = (low >>> 24) & 0xff;
    padded[tail + 5] = (low >>> 16) & 0xff;
    padded[tail + 6] = (low >>> 8) & 0xff;
    padded[tail + 7] = low & 0xff;

    var w = new Int32Array(64);
    for (var offset = 0; offset < padded.length; offset += 64) {
      for (var i = 0; i < 16; i++) {
        w[i] = (padded[offset + i * 4] << 24) | (padded[offset + i * 4 + 1] << 16) | (padded[offset + i * 4 + 2] << 8) | padded[offset + i * 4 + 3];
      }
      for (var t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = h[0];
      var b = h[1];
      var c = h[2];
      var d = h[3];
      var e = h[4];
      var f = h[5];
      var g = h[6];
      var hh = h[7];
      for (var j = 0; j < 64; j++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (hh + S1 + ch + K[j] + w[j]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) | 0;
        hh = g;
        g = f;
        f = e;
        e = (d + temp1) | 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) | 0;
      }
      h[0] = (h[0] + a) | 0;
      h[1] = (h[1] + b) | 0;
      h[2] = (h[2] + c) | 0;
      h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0;
      h[5] = (h[5] + f) | 0;
      h[6] = (h[6] + g) | 0;
      h[7] = (h[7] + hh) | 0;
    }
    var out = new Uint8Array(32);
    for (var k = 0; k < 8; k++) {
      out[k * 4] = (h[k] >>> 24) & 0xff;
      out[k * 4 + 1] = (h[k] >>> 16) & 0xff;
      out[k * 4 + 2] = (h[k] >>> 8) & 0xff;
      out[k * 4 + 3] = h[k] & 0xff;
    }
    return out;
  }

  /** HMAC-SHA256 */
  function hmacSha256(key, msg) {
    var block = 64;
    var normalized = key.length > block ? sha256(key) : key;
    var inner = new Uint8Array(block);
    var outer = new Uint8Array(block);
    for (var i = 0; i < block; i++) {
      var b = i < normalized.length ? normalized[i] : 0;
      inner[i] = b ^ 0x36;
      outer[i] = b ^ 0x5c;
    }
    return sha256(concat(outer, sha256(concat(inner, msg))));
  }

  /** PBKDF2-HMAC-SHA256 */
  function pbkdf2(password, salt, iterations, dkLen) {
    var hLen = 32;
    var blocks = Math.ceil(dkLen / hLen);
    var out = new Uint8Array(blocks * hLen);
    for (var i = 1; i <= blocks; i++) {
      // U1 = PRF(password, salt || INT(i))
      var index = new Uint8Array(4);
      index[0] = (i >>> 24) & 0xff;
      index[1] = (i >>> 16) & 0xff;
      index[2] = (i >>> 8) & 0xff;
      index[3] = i & 0xff;
      var u = hmacSha256(password, concat(salt, index));
      var t = u.slice(0);
      for (var j = 1; j < iterations; j++) {
        u = hmacSha256(password, u);
        for (var k = 0; k < hLen; k++) t[k] ^= u[k];
      }
      out.set(t, (i - 1) * hLen);
    }
    return out.slice(0, dkLen);
  }

  /**
   * 计算口令/令牌的摘要（hex）。
   *
   * @param {string} secret 明文口令或令牌
   * @param {string} saltHex 服务端公开的盐值（hex）
   * @param {number} iterations 迭代次数
   * @returns {string} 摘要（hex）
   */
  function pbkdf2Hex(secret, saltHex, iterations) {
    return toHex(pbkdf2(utf8(secret), fromHex(saltHex), Number(iterations) || 1, 32));
  }

  var api = { pbkdf2Hex: pbkdf2Hex, sha256Hex: function (text) { return toHex(sha256(utf8(text))); } };
  global.LocalsendCrypto = api;
  // Node 环境（测试）下也能直接引用
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
