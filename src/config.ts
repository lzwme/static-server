import { type Options } from 'http-proxy-middleware';
import { type ServerOptions } from 'node:https';
import { type Response } from 'express';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, Stats } from 'node:fs';
import { assign } from '@lzwme/fe-utils';
import { logger } from './get-logger';
import { getCert } from './lib/get-cert';

export interface SSConfig {
  /** 根目录 */
  rootDir?: string;
  /** 启动后是否打开首页 */
  open?: boolean;
  /** 监听端口号。默认 80，开启 https 则为 443 */
  port?: number;
  /** host 地址。默认为 127.0.0.1 */
  host?: string;
  /** 代理转发配置 */
  proxyConfig?: { api: string; config: Options }[];
  /** 是否开启日志记录。默认为 false。若设置为 true 则默认为 ~/.sserver/log.log；若为字符串，则设置为日志路径 */
  log?: boolean | string;
  /** 是否为 https 模式 */
  https?: boolean;
  /** 指定 https 模式相关的 ssl 配置 */
  ssl?: ServerOptions;
  /** 自动生成 ssl 的缓存目录 */
  sslCache?: string;
  /** 设置公共自定义 headers */
  headers?: Record<string, string | string[] | undefined>;
  /** 按请求自定义 headers。返回结果与 headers 内容合并 */
  setHeaders?: (
    res: Response<any, Record<string, any>>,
    path: string,
    stat: Stats
  ) => Record<string, string | string[] | undefined>;
}

const ssConfig: SSConfig = {
  rootDir: '.',
  open: false,
  proxyConfig: [],
  log: false,
  ssl: {
    rejectUnauthorized: false,
    requestCert: true,
  },
  headers: {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
  },
};

export async function getConfig(useCache = true, cfg?: SSConfig) {
  if (ssConfig.port && useCache) return ssConfig;

  const cfgFile = resolve(process.cwd(), './ss.config.js');
  if (existsSync(cfgFile)) assign(ssConfig, require(cfgFile));

  if (cfg) assign(ssConfig, cfg);

  if (ssConfig.log) {
    logger.setLogDir(typeof ssConfig.log === 'boolean' ? resolve(homedir(), '.sserver/log.log') : ssConfig.log);
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
