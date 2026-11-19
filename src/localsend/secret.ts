/*
 * LocalSend 密钥摘要
 *
 * 口令与访问令牌不再以明文形式在网络上流转，也不再出现在 URL 里：
 *
 *  1. 服务端为每个密钥生成一枚公开的随机盐值，并公布出去
 *  2. 客户端用盐值把口令/令牌派生成摘要（PBKDF2-HMAC-SHA256）
 *  3. 客户端把摘要放在请求体或请求头里提交，明文始终留在用户手里
 *  4. 服务端只保存摘要，收到摘要后比对即可
 *
 * 为什么用 PBKDF2 而不是直接 SHA-256：
 *  - 盐值随机且公开给客户端，但让摘要无法被彩虹表直接命中
 *  - 迭代次数把穷举弱口令的成本抬高若干个数量级
 *  - 摘要与明文一一对应，客户端算一次、服务端存一份，双方都不再处理明文
 *
 * 只有 WebDAV 是个例外：资源管理器等客户端只能用 Basic Auth 传明文，
 * 这类请求由服务端用同一套盐值现场算摘要后再比对（见 webdav.ts）。
 */
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/** 密钥种类 */
export type SecretKind = 'token' | 'password' | 'visitorPassword';

/** PBKDF2 迭代次数：口令越弱，破解成本越重要 */
export const SECRET_ITERATIONS = 10000;
/** 盐值字节数 */
const SALT_BYTES = 16;
/** 派生密钥字节数 */
const KEY_BYTES = 32;

/** 某个密钥的公开信息 */
export interface SecretInfo {
  /** 密钥种类 */
  kind: SecretKind;
  /** 公开盐值（hex） */
  salt: string;
  /** 迭代次数 */
  iterations: number;
}

/** 密钥摘要库 */
export interface SecretStore {
  /** 用明文刷新某个密钥：重新生成盐值并计算摘要 */
  refresh: (kind: SecretKind, plaintext: string) => void;
  /** 某个密钥的公开信息；未配置返回 null */
  info: (kind: SecretKind) => SecretInfo | null;
  /** 已配置密钥的公开信息列表 */
  list: () => SecretInfo[];
  /** 是否配置了某个密钥 */
  has: (kind: SecretKind) => boolean;
  /** 明文的摘要（用于只能传明文的场景，如 WebDAV Basic Auth） */
  digestOf: (kind: SecretKind, plaintext: string) => string;
  /** 校验客户端提交的摘要 */
  verify: (kind: SecretKind, presented: string) => boolean;
  /** 在所有已配置的密钥里找匹配的种类；没有匹配返回 null */
  match: (presented: string) => SecretKind | null;
}

/** 计算 PBKDF2 摘要（hex） */
function derive(plaintext: string, saltHex: string, iterations: number): string {
  return pbkdf2Sync(String(plaintext ?? ''), Buffer.from(saltHex, 'hex'), iterations, KEY_BYTES, 'sha256').toString('hex');
}

/** 十六进制字符串转字节 */
function fromHex(hex: string): Buffer {
  return Buffer.from(String(hex || ''), 'hex');
}

/** 恒定时间比较两个 hex 摘要 */
function safeEqualHex(a: string, b: string): boolean {
  const bufA = fromHex(a);
  const bufB = fromHex(b);
  if (!bufA.length || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createSecretStore(): SecretStore {
  /** kind -> { salt, digest } */
  const secrets = new Map<SecretKind, { salt: string; digest: string }>();

  const refresh = (kind: SecretKind, plaintext: string): void => {
    const value = String(plaintext ?? '');
    if (!value) {
      // 未配置：清掉旧的盐值与摘要
      secrets.delete(kind);
      return;
    }
    const salt = randomBytes(SALT_BYTES).toString('hex');
    secrets.set(kind, { salt, digest: derive(value, salt, SECRET_ITERATIONS) });
  };

  const info = (kind: SecretKind): SecretInfo | null => {
    const item = secrets.get(kind);
    if (!item) return null;
    return { kind, salt: item.salt, iterations: SECRET_ITERATIONS };
  };

  const digestOf = (kind: SecretKind, plaintext: string): string => {
    const item = secrets.get(kind);
    if (!item) return '';
    return derive(plaintext, item.salt, SECRET_ITERATIONS);
  };

  const verify = (kind: SecretKind, presented: string): boolean => {
    const item = secrets.get(kind);
    if (!item) return false;
    return safeEqualHex(item.digest, String(presented || ''));
  };

  const match = (presented: string): SecretKind | null => {
    const value = String(presented || '');
    if (!value) return null;
    for (const [kind, item] of secrets) {
      if (safeEqualHex(item.digest, value)) return kind;
    }
    return null;
  };

  return {
    refresh,
    info,
    list: () => [...secrets.keys()].map((kind) => info(kind) as SecretInfo),
    has: (kind) => secrets.has(kind),
    digestOf,
    verify,
    match,
  };
}
