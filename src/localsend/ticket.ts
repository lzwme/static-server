/*
 * LocalSend 短期访问票据
 *
 * 下载、预览、打包、事件流这几类请求没法带自定义请求头：
 * <img src>、<video src>、<a download>、EventSource 都只能给一个 URL。
 * 之前的做法是把会话令牌拼在 URL 上（?session=），于是一个「复制链接」动作
 * 就把自己的会话发给了别人，URL 还会留在浏览器历史与网关日志里。
 *
 * 这里改为「先换票、再用票访问」：
 *  - 票据只对指定的几个文件（或事件流）有效，不能拿去访问别的路径
 *  - 有效期很短（默认 2 分钟；事件流 30 分钟），过期即失效
 *  - 票据不携带任何身份信息，泄露的影响面远小于会话令牌
 *  - 不消费（可重复使用），因为视频拖动进度条、断点下载都会多次请求同一 URL
 */
import { randomBytes } from 'node:crypto';

/** 票据用途 */
export type TicketScope = 'download' | 'preview' | 'zip' | 'events';

/** 一张票据 */
export interface TicketEntry {
  /** 票据令牌 */
  token: string;
  /** 用途 */
  scope: TicketScope;
  /** 允许访问的文件相对路径；事件流为空数组 */
  names: string[];
  /** 过期时间戳 */
  expiresAt: number;
}

export interface TicketStoreOptions {
  /** 文件类票据的有效期（毫秒），默认 2 分钟 */
  ttl?: number;
  /** 事件流票据的有效期（毫秒），默认 30 分钟 */
  eventsTtl?: number;
  /** 同时存在的票据上限，超过后淘汰最早过期的 */
  max?: number;
}

export interface TicketStore {
  /** 签发一张票据 */
  issue: (scope: TicketScope, names?: string[], ttlMs?: number) => TicketEntry;
  /** 取票据；用途不匹配或已过期返回 null */
  get: (token: string, scope?: TicketScope) => TicketEntry | null;
  /** 票据是否允许访问该文件 */
  allows: (entry: TicketEntry, rel: string) => boolean;
  /** 清理过期票据，返回清理数量 */
  cleanup: () => number;
  /** 当前票据数量（用于测试与诊断） */
  size: () => number;
  /** 停止定时清理 */
  stop: () => void;
}

/** 文件类票据默认有效期：够页面加载资源，又不足以被反复利用 */
export const TICKET_TTL = 2 * 60 * 1000;
/** 事件流票据有效期：EventSource 会长时间挂着，需要比文件票据长 */
export const TICKET_EVENTS_TTL = 30 * 60 * 1000;
/** 同时存在的票据上限 */
const MAX_TICKETS = 1000;

export function createTicketStore(options: TicketStoreOptions = {}): TicketStore {
  const ttl = options.ttl ?? TICKET_TTL;
  const eventsTtl = options.eventsTtl ?? TICKET_EVENTS_TTL;
  const max = options.max ?? MAX_TICKETS;
  const tickets = new Map<string, TicketEntry>();

  /** 清掉过期票据；数量超限时按插入顺序淘汰最旧的 */
  const cleanup = (): number => {
    const now = Date.now();
    let removed = 0;
    for (const [token, entry] of tickets) {
      if (entry.expiresAt <= now) {
        tickets.delete(token);
        removed += 1;
      }
    }
    while (tickets.size > max) {
      const oldest = tickets.keys().next();
      if (oldest.done) break;
      tickets.delete(oldest.value);
      removed += 1;
    }
    return removed;
  };

  // 每分钟清理一次：票据数量不大，不需要更频繁
  const timer = setInterval(cleanup, 60 * 1000);
  timer.unref?.();

  return {
    issue(scope, names = [], ttlMs) {
      const token = randomBytes(18).toString('base64url');
      const lifetime = ttlMs ?? (scope === 'events' ? eventsTtl : ttl);
      const entry: TicketEntry = {
        token,
        scope,
        names: names.slice(0, 500),
        expiresAt: Date.now() + lifetime,
      };
      tickets.set(token, entry);
      // 插入后再清理：既回收过期票据，也保证数量不超上限（淘汰最旧的）
      cleanup();
      return entry;
    },

    get(token, scope) {
      const entry = tickets.get(String(token || ''));
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        tickets.delete(entry.token);
        return null;
      }
      if (scope && entry.scope !== scope) return null;
      return entry;
    },

    allows(entry, rel) {
      // 事件流不针对具体文件
      if (entry.scope === 'events') return true;
      // 没有限定文件时不允许访问任何文件，避免票据变成万能钥匙
      if (!entry.names.length) return false;
      return entry.names.includes(rel);
    },

    cleanup,

    size() {
      return tickets.size;
    },

    stop() {
      clearInterval(timer);
      tickets.clear();
    },
  };
}
