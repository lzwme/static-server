/*
 * LocalSend 分享链接
 *
 * 生成带时效的一次性分享令牌，拿到链接的人无需访问令牌即可下载指定文件。
 * 令牌只存在内存中，服务重启即失效；到期自动失效。
 */
import { randomBytes } from 'node:crypto';

export interface ShareEntry {
  /** 分享的相对路径列表，单个文件直接下载，多个文件打成 zip */
  names: string[];
  /** 创建时间 */
  createdAt: number;
  /** 过期时间戳 */
  expiresAt: number;
  /** 下载次数 */
  hits: number;
}

export interface ShareStore {
  /** 创建分享，返回令牌 */
  create: (names: string[], ttlMs?: number) => { token: string; entry: ShareEntry };
  /** 按令牌取分享，已过期返回 null */
  get: (token: string) => ShareEntry | null;
  /** 列出未过期的分享 */
  list: () => { token: string; entry: ShareEntry }[];
  /** 撤销某个分享 */
  revoke: (token: string) => boolean;
  /** 清理过期分享 */
  cleanup: () => number;
  /** 停止定时清理（进程退出或测试收尾时调用） */
  stop: () => void;
}

export function createShareStore(): ShareStore {
  const shares = new Map<string, ShareEntry>();

  const cleanup = () => {
    const now = Date.now();
    let count = 0;
    for (const [token, entry] of shares) {
      if (entry.expiresAt <= now) {
        shares.delete(token);
        count++;
      }
    }
    return count;
  };

  // 每 10 分钟清理一次过期分享
  const timer = setInterval(cleanup, 10 * 60 * 1000);
  timer.unref?.();

  return {
    create(names, ttlMs = 24 * 60 * 60 * 1000) {
      cleanup();
      const token = randomBytes(16).toString('base64url');
      const now = Date.now();
      const entry: ShareEntry = { names, createdAt: now, expiresAt: now + ttlMs, hits: 0 };
      shares.set(token, entry);
      return { token, entry };
    },
    get(token) {
      const entry = shares.get(token);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        shares.delete(token);
        return null;
      }
      entry.hits++;
      return entry;
    },
    list() {
      cleanup();
      return [...shares.entries()].map(([token, entry]) => ({ token, entry }));
    },
    revoke(token) {
      return shares.delete(token);
    },
    cleanup,
    stop() {
      clearInterval(timer);
    },
  };
}
