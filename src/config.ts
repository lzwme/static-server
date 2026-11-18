import { existsSync, readFileSync, type Stats } from 'node:fs';
import type { ServerOptions } from 'node:https';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { color, NLogger } from '@lzwme/fe-utils';
import type { Express, Response } from 'express';
import type { Options } from 'http-proxy-middleware';
import { logger } from './get-logger';
import { getCert } from './lib/get-cert';
import { isPlainObject, mergeConfig } from './lib/merge-config';

export interface LocalSendConfig {
  /** 是否开启 localsend 局域网文件传输功能 */
  enabled?: boolean;
  /** 文件存储目录。默认 ~/.static-server/localsend，可通过环境变量 SS_LOCALSEND_DIR 指定 */
  dir?: string;
  /** 单个文件上传大小限制（字节）。默认 1GB */
  maxSize?: number;
  /** 存储目录总容量上限（字节）。超出后拒绝新的上传。默认不限制 */
  maxTotalSize?: number;
  /** 访问令牌。设置后，页面与所有接口都需要携带（?key=xxx 或 X-Localsend-Key 请求头） */
  token?: string;
  /** 管理员口令。设置后删除文件、整理目录、撤销分享等危险操作需要登录 */
  password?: string;
  /** 访客口令（可选）。设置后访客可上传下载，但不能删除与整理 */
  visitorPassword?: string;
  /** 登录会话有效期（毫秒）。默认 24 小时 */
  sessionTtl?: number;
  /** 单个 IP 的最大并发上传数。默认 3 */
  maxConcurrent?: number;
  /** 单个 IP 的请求频率限制。默认 120 次 / 60 秒 */
  rateLimit?: { windowMs?: number; max?: number };
  /** 禁止上传的文件扩展名列表（如 ['.php', '.phtml']）。默认禁止常见服务端脚本 */
  blockExtensions?: string[];
  /** 自动清理：文件的保留天数，超过后自动删除 */
  autoCleanDays?: number;
  /** 自动清理：存储目录容量上限（字节），超出后自动删除最旧的文件 */
  autoCleanMaxSize?: number;
  /** 回收站保留天数。删除的文件在保留期内可还原，默认 1 天 */
  trashDays?: number;
  /** 是否开启 WebDAV 挂载接口（/localsend/dav），可把存储目录挂载为网络盘。默认开启 */
  webdav?: boolean;
}

export interface SSConfig {
  /** 是否开启目录列表 */
  autoindex?: boolean;
  /** 自定义 app 应用逻辑 */
  custom?(app: Express, config: SSConfig, logger: NLogger, c: Partial<typeof color>): void;
  /** host 地址。默认为 127.0.0.1 */
  host?: string;
  /** 是否开启日志记录。默认为 false。若设置为 true 则默认为 ~/.sserver/log.log；若为字符串，则设置为日志路径 */
  log?: boolean | string;
  /** localsend 局域网文件传输功能。可设置为 true 开启，或传入配置对象 */
  localsend?: LocalSendConfig | boolean;
  /** 启动后是否打开首页 */
  open?: boolean;
  /** 监听端口号。默认 80，开启 https 则为 443 */
  port?: number;
  /** 代理转发配置 */
  proxyConfig?: { api: string; config: Options }[];
  phpConfig?: {
    /** 执行 php-cgi 的路径。默认系统可执行路径获取 */
    cgiPath?: string;
    /** php-cgi port。默认为 9010 */
    port?: number | string;
    /** php-cgi 命令行参数 */
    args?: Record<string, string>;
    /** 是否仅处理 php 文件的请求。否则会处理所有静态文件的请求。默认 true */
    onlyPhpFile?: boolean;
  };
  /** 根目录 */
  rootDir?: string;
  /** 是否为 https 模式 */
  https?: boolean;
  /** 指定 https 模式相关的 ssl 配置 */
  ssl?: ServerOptions;
  /** 自动生成 ssl 的缓存目录 */
  sslCache?: string;
  /** 是否默认开启 cors 设置 */
  cors?: boolean;
  /** 设置公共自定义 headers */
  headers?: Record<string, string | string[] | undefined>;
  /** 按请求自定义 headers。返回结果与 headers 内容合并 */
  setHeaders?: (res: Response<any, Record<string, any>>, path: string, stat: Stats) => Record<string, string | string[] | undefined>;
}

/** 用户级配置目录名。默认位于用户主目录下 */
export const USER_CONFIG_DIR = '.static-server';
/** 配置文件名 */
export const CONFIG_FILE_NAME = 'ss.config.js';

/** 用户级配置目录：~/.static-server */
export function getUserConfigDir(): string {
  return resolve(homedir(), USER_CONFIG_DIR);
}

/** 用户级配置文件：~/.static-server/ss.config.js */
export function getUserConfigFile(): string {
  return resolve(getUserConfigDir(), CONFIG_FILE_NAME);
}

/** 当前工作目录下的配置文件：./ss.config.js */
export function getCwdConfigFile(): string {
  return resolve(process.cwd(), CONFIG_FILE_NAME);
}

/**
 * 加载配置文件。
 * 文件不存在时返回 undefined；加载失败时输出错误提示并忽略该文件，避免整个服务启动失败。
 */
function loadConfigFile(file: string): Partial<SSConfig> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const mod = require(file);
    const cfg = mod && typeof mod === 'object' && mod.__esModule && mod.default ? mod.default : mod;
    return isPlainObject(cfg) ? (cfg as Partial<SSConfig>) : undefined;
  } catch (e) {
    logger.error(`配置文件加载失败，已忽略该文件：${file}`, e);
    return undefined;
  }
}

/** 归一化单个配置文件的内容，使其可与其它配置深度合并 */
function normalizeConfig(cfg?: Partial<SSConfig>): Partial<SSConfig> | undefined {
  if (!cfg) return undefined;
  // localsend 支持布尔值，归一化为对象后再合并，避免布尔值覆盖掉对象配置
  if (typeof cfg.localsend === 'boolean') return { ...cfg, localsend: { enabled: cfg.localsend } };
  return cfg;
}

const ssConfig: SSConfig = {
  log: false,
  open: false,
  phpConfig: {
    onlyPhpFile: true,
    args: {},
  },
  proxyConfig: [],
  rootDir: '.',
  cors: true,
  ssl: {
    rejectUnauthorized: false,
    requestCert: true,
  },
  headers: {},
};

export async function getConfig(useCache = true, cfg?: SSConfig) {
  if (ssConfig.port && useCache) return ssConfig;

  // 配置优先级：内置默认值 < 用户级配置(~/.static-server/ss.config.js) < 当前目录配置(./ss.config.js) < 运行时参数
  mergeConfig(ssConfig, normalizeConfig(loadConfigFile(getUserConfigFile())));
  mergeConfig(ssConfig, normalizeConfig(loadConfigFile(getCwdConfigFile())));

  if (cfg) mergeConfig(ssConfig, cfg);

  ssConfig.rootDir = resolve(process.cwd(), typeof ssConfig.rootDir === 'string' ? ssConfig.rootDir : '.');

  // localsend 配置归一化：支持 true / 配置对象，支持环境变量 SS_LOCALSEND_DIR 指定存储目录
  if (ssConfig.localsend) {
    const localsend: LocalSendConfig =
      typeof ssConfig.localsend === 'boolean' ? { enabled: ssConfig.localsend } : { ...ssConfig.localsend };
    localsend.enabled = typeof ssConfig.localsend === 'boolean' ? ssConfig.localsend : localsend.enabled !== false;
    localsend.dir = process.env.SS_LOCALSEND_DIR || localsend.dir || resolve(getUserConfigDir(), 'localsend');
    localsend.maxSize = localsend.maxSize || 1024 * 1024 * 1024;
    ssConfig.localsend = localsend;
  }

  if (ssConfig.log) {
    logger.setLogDir(typeof ssConfig.log === 'boolean' ? resolve(homedir(), '.sserver/log.log') : ssConfig.log);
  }

  if (ssConfig.cors) {
    Object.assign(ssConfig.headers!, {
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Opener-Policy': 'cross-origin',
    });
  }

  if (ssConfig.https && ssConfig.ssl) {
    const { ssl } = ssConfig;

    if (ssConfig.https && !ssl.cert) {
      const info = await getCert(ssConfig.host, ssConfig.sslCache || '');
      ssl.key = Buffer.from(info.certKey);
      ssl.cert = Buffer.from(info.certCrt);
      ssl.ca = Buffer.from(info.caKey);
    }

    for (const key of ['key', 'cert', 'ca'] as const) {
      const val = ssl[key];
      if (typeof val === 'string' && existsSync(val)) ssl[key] = readFileSync(val);
    }
  }

  if (!ssConfig.port) ssConfig.port = ssConfig.https ? 443 : 80;

  return ssConfig;
}
