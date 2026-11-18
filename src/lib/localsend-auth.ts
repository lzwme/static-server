/*
 * LocalSend 身份与权限
 *
 * 之前只有站点级的访问令牌（token）：要么全站都要 key，要么全站敞开，
 * 进来的人一律是管理员，删除、清理、撤销分享这些危险操作没有任何身份校验。
 *
 * 这里在令牌之下加一层身份，把危险动作的权限收回来：
 *
 *  - 管理员（admin）：用管理员口令登录，可以删除文件、整理目录、撤销分享
 *  - 访客（visitor）：用访客口令登录，可以上传下载，但不能删除与整理
 *  - 只读（guest）：未登录，只能浏览与下载
 *  - 开放（open）：没有配置任何口令时的兼容模式，行为与以前完全一致
 *
 * 会话只存在内存里，服务重启即失效；口令比较使用常量时间算法，
 * 避免通过响应耗时逐位试探。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 权限角色 */
export type Role = 'admin' | 'visitor' | 'guest' | 'open';

/** 已登录会话 */
export interface Session {
  /** 会话令牌 */
  token: string;
  /** 该会话的权限角色 */
  role: 'admin' | 'visitor';
  /** 创建时间 */
  createdAt: number;
  /** 过期时间戳 */
  expiresAt: number;
}

export interface AuthOptions {
  /** 管理员口令。设置后危险操作需要登录 */
  password?: string;
  /** 访客口令（可选）。设置后访客可上传下载但不能删除与整理 */
  visitorPassword?: string;
  /** 会话有效期（毫秒），默认 24 小时 */
  sessionTtl?: number;
}

export interface Auth {
  /** 是否为开放模式（未配置任何口令） */
  readonly open: boolean;
  /** 是否配置了管理员口令 */
  readonly hasAdmin: boolean;
  /** 校验口令并建立会话，口令不匹配返回 null */
  login: (password: string) => Session | null;
  /** 注销会话，返回是否确实注销了 */
  logout: (token: string) => boolean;
  /** 取会话，已过期返回 null */
  get: (token: string) => Session | null;
  /** 判定某个会话令牌对应的角色 */
  roleOf: (token: string) => Role;
  /** 清理过期会话，返回清理数量 */
  cleanup: () => number;
  /** 停止定时清理 */
  stop: () => void;
}

/** 常量时间比较两个字符串，长度不同直接返回 false */
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createAuth(options: AuthOptions = {}): Auth {
  const password = options.password || '';
  const visitorPassword = options.visitorPassword || '';
  const ttl = options.sessionTtl ?? 24 * 60 * 60 * 1000;

  /** token -> 会话 */
  const sessions = new Map<string, Session>();

  const cleanup = () => {
    const now = Date.now();
    let count = 0;
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) {
        sessions.delete(token);
        count += 1;
      }
    }
    return count;
  };

  // 每 10 分钟清理一次过期会话
  const timer = setInterval(cleanup, 10 * 60 * 1000);
  timer.unref?.();

  return {
    get open() {
      return !password && !visitorPassword;
    },
    get hasAdmin() {
      return !!password;
    },
    login(input) {
      const value = String(input ?? '');
      if (!value) return null;
      // 管理员口令优先
      if (password && safeEqual(value, password)) {
        const now = Date.now();
        const session: Session = { token: randomBytes(24).toString('base64url'), role: 'admin', createdAt: now, expiresAt: now + ttl };
        sessions.set(session.token, session);
        return session;
      }
      if (visitorPassword && safeEqual(value, visitorPassword)) {
        const now = Date.now();
        const session: Session = { token: randomBytes(24).toString('base64url'), role: 'visitor', createdAt: now, expiresAt: now + ttl };
        sessions.set(session.token, session);
        return session;
      }
      return null;
    },
    logout(token) {
      return sessions.delete(token);
    },
    get(token) {
      if (!token) return null;
      const session = sessions.get(token);
      if (!session) return null;
      if (session.expiresAt <= Date.now()) {
        sessions.delete(token);
        return null;
      }
      return session;
    },
    roleOf(token) {
      // 没有配置任何口令时保持开放模式，行为与以前完全一致
      if (!password && !visitorPassword) return 'open';
      const session = this.get(token);
      if (!session) return 'guest';
      return session.role;
    },
    cleanup,
    stop() {
      clearInterval(timer);
    },
  };
}

/** 角色是否允许执行危险操作（删除、整理、撤销分享等） */
export function canManage(role: Role): boolean {
  return role === 'admin' || role === 'open';
}

/** 角色是否允许写入（上传、粘贴、创建分享等） */
export function canWrite(role: Role): boolean {
  return role === 'admin' || role === 'visitor' || role === 'open';
}
