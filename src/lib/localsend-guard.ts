/*
 * LocalSend 访问防护
 *  - 访问令牌：设置后页面与接口都需要携带 key（?key=xxx 或 X-Localsend-Key 头）
 *  - 频率限制：单 IP 在滑动窗口内的最大请求数
 *  - 并发限制：单 IP 同时进行的上传数
 *
 * 局域网工具默认是不设防的，但只要有人知道地址就能上传/下载/删除文件，
 * 因此提供这三道可选的防护，默认关闭（不改变现有使用习惯）。
 */
import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface GuardOptions {
  /** 访问令牌。为空表示不校验 */
  token?: string;
  /** 单 IP 最大并发上传数，默认 3 */
  maxConcurrent?: number;
  /** 频率限制：窗口毫秒数与窗口内最大请求数，默认 120 次 / 60 秒 */
  rateLimit?: { windowMs?: number; max?: number };
}

export interface Guard {
  requireToken: (req: Request, res: Response, next: NextFunction) => void;
  rateLimit: (req: Request, res: Response, next: NextFunction) => void;
  limitConcurrent: (req: Request, res: Response, next: NextFunction) => void;
  /** 当前并发占用统计（用于状态查询） */
  stats: () => { concurrent: number; ips: number };
}

/** 字符串常量时间比较，避免令牌被逐字符试探 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 取客户端 IP（局域网内通常是同一网段，取首个地址即可） */
function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return ip || req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * 静态资源（样式、脚本、图标、清单等）不包含任何用户数据，
 * 且页面里的 <link>/<script> 标签无法携带令牌，
 * 因此这些请求放行，避免启用令牌后页面丢失样式与脚本。
 * 文件列表、上传、下载等接口仍然需要校验令牌。
 */
const STATIC_ASSET_RE = /\.(css|js|mjs|json|webmanifest|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf)$/i;

export function createGuard(options: GuardOptions = {}): Guard {
  const token = options.token || '';
  const maxConcurrent = options.maxConcurrent ?? 3;
  const windowMs = options.rateLimit?.windowMs ?? 60_000;
  const maxRequests = options.rateLimit?.max ?? 120;

  /** ip -> 当前并发数 */
  const concurrent = new Map<string, number>();
  /** ip -> 最近请求时间戳队列 */
  const hits = new Map<string, number[]>();

  // 定期清理过期数据，避免长期运行内存增长
  const timer = setInterval(
    () => {
      const now = Date.now();
      for (const [ip, list] of hits) {
        const valid = list.filter((t) => now - t < windowMs);
        if (valid.length) hits.set(ip, valid);
        else hits.delete(ip);
      }
      for (const [ip, count] of concurrent) {
        if (count <= 0) concurrent.delete(ip);
      }
    },
    Math.max(windowMs, 30_000),
  );
  timer.unref?.();

  const requireToken: Guard['requireToken'] = (req, res, next) => {
    if (!token) return next();
    // 静态资源无需令牌（接口路径除外，避免以 .css 等后缀绕过校验）
    if (!req.path.startsWith('/api/') && STATIC_ASSET_RE.test(req.path)) return next();
    const key = String(req.query.key || req.get('X-Localsend-Key') || '');
    if (key && safeEqual(key, token)) return next();

    if (req.path.startsWith('/api/')) {
      res.status(401).json({ code: 1, msg: '访问令牌无效或缺失' });
    } else {
      res
        .status(401)
        .type('html')
        .send(
          '<meta charset="utf-8"><div style="font-family:system-ui;padding:40px;text-align:center">' +
            '<h2>需要访问令牌</h2><p>请使用带 <code>?key=令牌</code> 的地址访问本页面。</p></div>',
        );
    }
  };

  const rateLimit: Guard['rateLimit'] = (req, res, next) => {
    if (!maxRequests || maxRequests <= 0) return next();
    const ip = clientIp(req);
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (list.length >= maxRequests) {
      res.status(429).json({ code: 1, msg: '请求过于频繁，请稍后再试' });
      return;
    }
    list.push(now);
    hits.set(ip, list);
    next();
  };

  const limitConcurrent: Guard['limitConcurrent'] = (req, res, next) => {
    if (!maxConcurrent || maxConcurrent <= 0) return next();
    const ip = clientIp(req);
    const current = concurrent.get(ip) || 0;
    if (current >= maxConcurrent) {
      res.status(429).json({ code: 1, msg: `并发上传数已达上限（${maxConcurrent}），请稍后再试` });
      return;
    }
    concurrent.set(ip, current + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = (concurrent.get(ip) || 1) - 1;
      if (count <= 0) concurrent.delete(ip);
      else concurrent.set(ip, count);
    };
    res.on('finish', release);
    res.on('close', release);
    next();
  };

  return {
    requireToken,
    rateLimit,
    limitConcurrent,
    stats: () => ({
      concurrent: [...concurrent.values()].reduce((a, b) => a + b, 0),
      ips: concurrent.size,
    }),
  };
}
