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
 *  - 只读（guest）：未登录。没有配置访客口令时可以上传下载；
 *    配置了访客口令则必须先输入口令
 *  - 开放（open）：没有配置任何口令时的兼容模式，行为与以前完全一致
 *
 * 口令与令牌都不再走明文：客户端用服务端公开的盐值派生出摘要后提交，
 * 服务端只保存摘要（见 secret.ts）。会话只存在内存里，服务重启即失效。
 */
import { randomBytes } from 'node:crypto';
import { createSecretStore, SECRET_ITERATIONS, type SecretInfo, type SecretKind } from './secret';

/** 权限角色 */
export type Role = 'admin' | 'visitor' | 'guest' | 'open';

/** 会话来源：口令登录 / 访问令牌登录 */
export type SessionVia = 'password' | 'token';

/** 已登录会话 */
export interface Session {
  /** 会话令牌 */
  token: string;
  /** 该会话的权限角色 */
  role: Role;
  /** 会话来源 */
  via: SessionVia;
  /** 创建时间 */
  createdAt: number;
  /** 过期时间戳 */
  expiresAt: number;
}

export interface AuthOptions {
  /** 管理员口令。设置后危险操作需要登录 */
  password?: string;
  /** 访客口令（可选）。设置后未登录用户必须输入该口令才能上传下载；留空则允许未登录用户上传下载 */
  visitorPassword?: string;
  /** 访问令牌（可选）。设置后需要输入令牌才能访问 */
  token?: string;
  /** 会话有效期（毫秒），默认 24 小时 */
  sessionTtl?: number;
}

export interface Auth {
  /** 是否为开放模式（未配置任何口令） */
  readonly open: boolean;
  /** 是否配置了管理员口令 */
  readonly hasAdmin: boolean;
  /** 是否配置了访客口令 */
  readonly hasVisitor: boolean;
  /** 是否配置了访问令牌 */
  readonly hasToken: boolean;
  /** 各密钥的公开盐值信息，供客户端派生摘要 */
  secrets: () => SecretInfo[];
  /** 校验口令或令牌摘要并建立会话，匹配不上返回 null */
  login: (digests: { password?: string; visitorPassword?: string; token?: string }) => Session | null;
  /** 校验访问令牌摘要并建立会话，匹配不上返回 null */
  loginByToken: (digest: string) => Session | null;
  /** 注销会话，返回是否确实注销了 */
  logout: (token: string) => boolean;
  /** 取会话，已过期返回 null */
  get: (token: string) => Session | null;
  /** 判定某个会话令牌对应的角色 */
  roleOf: (token: string) => Role;
  /**
   * 运行时更新口令、令牌与会话有效期。
   *
   * 口令一旦变更，此前签发的会话全部失效（keepToken 指定的当前会话保留），
   * 避免口令泄露后旧会话仍能继续使用；
   * 访问令牌变更只作废「用令牌换来的会话」，口令登录的会话不受影响。
   */
  update: (options: { password?: string; visitorPassword?: string; token?: string; sessionTtl?: number }, keepToken?: string) => void;
  /** 校验管理员口令摘要 */
  verifyAdmin: (digest: string) => boolean;
  /** 校验明文口令（WebDAV Basic Auth 这类只能传明文的场景），返回匹配的密钥种类 */
  verifyPlain: (plaintext: string) => SecretKind | null;
  /** 明文口令对应的角色 */
  plainRole: (plaintext: string) => Role | null;
  /** 校验访问令牌摘要（请求头 X-Localsend-Key） */
  verifyToken: (digest: string) => boolean;
  /** 校验访问令牌：同时接受明文与摘要两种形式 */
  verifyTokenValue: (presented: string) => boolean;
  /** 清理过期会话，返回清理数量 */
  cleanup: () => number;
  /** 停止定时清理 */
  stop: () => void;
}

export function createAuth(options: AuthOptions = {}): Auth {
  let password = options.password || '';
  let visitorPassword = options.visitorPassword || '';
  let token = options.token || '';
  let ttl = options.sessionTtl ?? 24 * 60 * 60 * 1000;

  /** 口令与令牌的摘要库 */
  const secrets = createSecretStore();
  secrets.refresh('password', password);
  secrets.refresh('visitorPassword', visitorPassword);
  secrets.refresh('token', token);

  /** token -> 会话 */
  const sessions = new Map<string, Session>();

  const cleanup = () => {
    const now = Date.now();
    let count = 0;
    for (const [key, session] of sessions) {
      if (session.expiresAt <= now) {
        sessions.delete(key);
        count += 1;
      }
    }
    return count;
  };

  // 每 10 分钟清理一次过期会话
  const timer = setInterval(cleanup, 10 * 60 * 1000);
  timer.unref?.();

  /** 未登录时的基础角色：没配置任何口令时是开放模式 */
  const baseRole = (): Role => (!password && !visitorPassword ? 'open' : 'guest');

  /** 建立会话 */
  const issue = (role: Role, via: SessionVia): Session => {
    const now = Date.now();
    const session: Session = { token: randomBytes(24).toString('base64url'), role, via, createdAt: now, expiresAt: now + ttl };
    sessions.set(session.token, session);
    return session;
  };

  return {
    get open() {
      return !password && !visitorPassword;
    },
    get hasAdmin() {
      return !!password;
    },
    get hasVisitor() {
      return !!visitorPassword;
    },
    get hasToken() {
      return !!token;
    },
    secrets: () => secrets.list(),
    login(digests) {
      const input = digests || {};
      // 管理员口令优先
      if (input.password && secrets.verify('password', input.password)) return issue('admin', 'password');
      if (input.visitorPassword && secrets.verify('visitorPassword', input.visitorPassword)) return issue('visitor', 'password');
      // 访问令牌也走同一个入口：前端只显示一个输入框，
      // 用户不必先分辨自己手里拿的是口令还是令牌
      if (input.token && secrets.verify('token', input.token)) return issue(baseRole(), 'token');
      return null;
    },
    loginByToken(digest) {
      if (!secrets.verify('token', String(digest || ''))) return null;
      // 令牌是站点级大门锁：没有配置口令时等同管理员，否则按访客口径
      return issue(baseRole(), 'token');
    },
    logout(key) {
      return sessions.delete(key);
    },
    get(key) {
      if (!key) return null;
      const session = sessions.get(key);
      if (!session) return null;
      if (session.expiresAt <= Date.now()) {
        sessions.delete(key);
        return null;
      }
      return session;
    },
    roleOf(key) {
      // 没有配置任何口令时保持开放模式，行为与以前完全一致
      if (!password && !visitorPassword) return 'open';
      const session = this.get(key);
      if (!session) return 'guest';
      return session.role;
    },
    update(next, keepToken) {
      let secretChanged = false;
      let tokenChanged = false;
      if (next.password !== undefined && next.password !== password) {
        password = next.password || '';
        secrets.refresh('password', password);
        secretChanged = true;
      }
      if (next.visitorPassword !== undefined && next.visitorPassword !== visitorPassword) {
        visitorPassword = next.visitorPassword || '';
        secrets.refresh('visitorPassword', visitorPassword);
        secretChanged = true;
      }
      if (next.token !== undefined && next.token !== token) {
        token = next.token || '';
        secrets.refresh('token', token);
        tokenChanged = true;
      }
      if (next.sessionTtl !== undefined && next.sessionTtl > 0) {
        ttl = next.sessionTtl;
      }
      // 口令变了：此前的会话全部失效，当前会话（keepToken）保留
      if (secretChanged) {
        for (const key of [...sessions.keys()]) {
          if (key === keepToken) continue;
          sessions.delete(key);
        }
      }
      // 令牌变了：只作废「用令牌换来的会话」，口令登录的会话继续有效
      if (tokenChanged) {
        for (const [key, session] of [...sessions.entries()]) {
          if (key === keepToken) continue;
          if (session.via === 'token') sessions.delete(key);
        }
      }
    },
    verifyAdmin(digest) {
      if (!password) return true;
      return secrets.verify('password', String(digest || ''));
    },
    verifyPlain(plaintext) {
      const value = String(plaintext ?? '');
      if (!value) return null;
      if (secrets.verify('password', secrets.digestOf('password', value))) return 'password';
      if (secrets.verify('visitorPassword', secrets.digestOf('visitorPassword', value))) return 'visitorPassword';
      if (secrets.verify('token', secrets.digestOf('token', value))) return 'token';
      return null;
    },
    plainRole(plaintext) {
      const kind = this.verifyPlain(plaintext);
      if (kind === 'password') return 'admin';
      if (kind === 'visitorPassword') return 'visitor';
      if (kind === 'token') return baseRole();
      return null;
    },
    verifyToken(digest) {
      return secrets.verify('token', String(digest || ''));
    },
    verifyTokenValue(presented) {
      const value = String(presented || '');
      if (!value) return false;
      // 摘要形式（脚本客户端）
      if (secrets.verify('token', value)) return true;
      // 明文形式（WebDAV 客户端只能传明文）
      return secrets.verify('token', secrets.digestOf('token', value));
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

/**
 * 角色是否允许写入（上传、粘贴、创建分享等）。
 *
 * 未登录（guest）能否写入取决于是否配置了访客口令：
 *  - 没有配置访客口令：允许任何人上传下载，删除与整理仍需管理员口令
 *  - 配置了访客口令：未登录时必须先输入口令登录，才能上传下载
 */
export function canWrite(role: Role, visitorConfigured = false): boolean {
  if (role === 'admin' || role === 'visitor' || role === 'open') return true;
  // guest：没有访客口令时开放上传
  return !visitorConfigured;
}

export type { SecretKind };
export { SECRET_ITERATIONS };
