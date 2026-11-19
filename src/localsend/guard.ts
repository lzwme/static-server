/*
 * LocalSend 访问防护
 *  - 访问令牌：设置后需要先输入令牌换取会话，之后用会话令牌访问接口
 *  - 频率限制：单 IP 在滑动窗口内的最大请求数
 *  - 并发限制：单 IP 同时进行的上传数
 *
 * 局域网工具默认是不设防的，但只要有人知道地址就能上传/下载/删除文件，
 * 因此提供这三道可选的防护，默认关闭（不改变现有使用习惯）。
 *
 * 访问令牌不再出现在 URL 里：页面与静态资源照常加载（里面没有用户数据），
 * 由前端提示用户输入令牌，输入后用令牌换取会话令牌；
 * 接口只认会话令牌或请求头里的令牌摘要。
 *
 * 未授权分两种情况，客户端要区别对待：
 *  - needToken：根本没带凭证（或令牌不对），需要用户输入访问令牌
 *  - needLogin：带了会话但服务端不认（口令变了、会话过期、服务重启），需要重新登录
 * 只回一个笼统的 401 会让前端分不清该弹令牌框还是登录框，
 * 也分不清「没登录」与「登录已失效」。
 */
import type { NextFunction, Request, Response } from 'express';

export interface GuardOptions {
  /** 是否配置了访问令牌。为空表示不校验。传入函数表示运行时取值 */
  hasToken?: () => boolean;
  /** 校验请求头里的访问令牌摘要 */
  verifyKey?: (digest: string) => boolean;
  /** 校验会话令牌 */
  verifySession?: (token: string) => boolean;
  /** 是否信任 X-Forwarded-For 作为客户端 IP。仅在部署于可信反向代理之后才开启，默认关闭（防止伪造绕过限流） */
  trustProxy?: boolean;
  /** 单 IP 最大并发上传数，默认 3。传入函数表示运行时取值 */
  maxConcurrent?: number | (() => number);
  /** 频率限制：窗口毫秒数与窗口内最大请求数，默认 120 次 / 60 秒。传入函数表示运行时取值 */
  rateLimit?: { windowMs?: number; max?: number } | (() => { windowMs?: number; max?: number } | undefined);
}

export interface Guard {
  requireAuth: (req: Request, res: Response, next: NextFunction) => void;
  rateLimit: (req: Request, res: Response, next: NextFunction) => void;
  limitConcurrent: (req: Request, res: Response, next: NextFunction) => void;
  /** 当前并发占用统计（用于状态查询） */
  stats: () => { concurrent: number; ips: number };
}

/** 取客户端 IP。X-Forwarded-For 完全由客户端提供，只有显式信任代理时才采用 */
function clientIp(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (ip) return ip;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * 静态资源（样式、脚本、图标、清单等）不包含任何用户数据，
 * 页面外壳同样不含用户数据，因此这些请求放行：
 * 即使启用了访问令牌，页面也能正常加载并提示用户输入令牌。
 * 文件列表、上传、下载等接口仍然需要会话令牌或令牌摘要。
 */
const STATIC_ASSET_RE = /\.(css|js|mjs|json|webmanifest|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf)$/i;

export function createGuard(options: GuardOptions = {}): Guard {
  const trustProxy = options.trustProxy === true;
  /** 是否配置了访问令牌（运行时读取） */
  const getHasToken = (): boolean => {
    if (typeof options.hasToken === 'function') return !!options.hasToken();
    return !!options.hasToken;
  };
  /** 校验请求头里的令牌摘要 */
  const verifyKey = (digest: string): boolean => {
    if (typeof options.verifyKey !== 'function') return false;
    return options.verifyKey(digest);
  };
  /** 校验会话令牌 */
  const verifySession = (token: string): boolean => {
    if (typeof options.verifySession !== 'function') return false;
    return options.verifySession(token);
  };
  /** 运行时读取当前生效的并发上限 */
  const getMaxConcurrent = (): number => {
    const value = typeof options.maxConcurrent === 'function' ? options.maxConcurrent() : options.maxConcurrent;
    return value ?? 3;
  };
  /** 运行时读取当前生效的频率限制 */
  const getRateLimit = (): { windowMs: number; max: number } => {
    const raw = typeof options.rateLimit === 'function' ? options.rateLimit() : options.rateLimit;
    return { windowMs: raw?.windowMs ?? 60_000, max: raw?.max ?? 120 };
  };

  /** ip -> 当前并发数 */
  const concurrent = new Map<string, number>();
  /** ip -> 最近请求时间戳队列 */
  const hits = new Map<string, number[]>();

  // 定期清理过期数据，避免长期运行内存增长
  const timer = setInterval(() => {
    const now = Date.now();
    const { windowMs } = getRateLimit();
    for (const [ip, list] of hits) {
      const valid = list.filter((t) => now - t < windowMs);
      if (valid.length) hits.set(ip, valid);
      else hits.delete(ip);
    }
    for (const [ip, count] of concurrent) {
      if (count <= 0) concurrent.delete(ip);
    }
  }, 30_000);
  timer.unref?.();

  const requireAuth: Guard['requireAuth'] = (req, res, next) => {
    // 静态资源与页面外壳不含用户数据，放行，
    // 让页面能正常加载并提示用户输入访问令牌
    if (!req.path.startsWith('/api/') && (STATIC_ASSET_RE.test(req.path) || req.path === '/' || req.path === '')) return next();
    // 会话令牌：优先用请求头；SSE、下载链接等无法带请求头的场景用查询参数
    const session = String(req.get('X-Localsend-Session') || req.query.session || '');
    if (session && verifySession(session)) return next();
    // 带了一个服务端不认的会话：会话失效（口令改了、会话过期、服务重启）。
    // 这与「从未登录」是两回事，必须明确告诉客户端「要重新认证」，
    // 否则客户端会一直以为已登录，界面显示的身份与服务端实际权限也会对不上。
    if (session && getHasToken()) {
      res.status(401).json({ code: 1, msg: '会话已失效，请重新登录', needLogin: true });
      return;
    }
    // 访问令牌摘要：放在请求头里，不进 URL
    const key = String(req.get('X-Localsend-Key') || '');
    if (key && verifyKey(key)) return next();
    // 配了访问令牌却没有可用凭证：属于「缺令牌」，提示用户输入令牌
    if (getHasToken()) {
      res.status(401).json({ code: 1, msg: '需要访问令牌', needToken: true });
      return;
    }
    // 没配访问令牌：按访客口径放行，具体权限由身份中间件按角色判断
    return next();
  };

  const rateLimit: Guard['rateLimit'] = (req, res, next) => {
    const { windowMs, max: maxRequests } = getRateLimit();
    if (!maxRequests || maxRequests <= 0) return next();
    const ip = clientIp(req, trustProxy);
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
    const maxConcurrent = getMaxConcurrent();
    if (!maxConcurrent || maxConcurrent <= 0) return next();
    const ip = clientIp(req, trustProxy);
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
    requireAuth,
    rateLimit,
    limitConcurrent,
    stats: () => ({
      concurrent: [...concurrent.values()].reduce((a, b) => a + b, 0),
      ips: concurrent.size,
    }),
  };
}
