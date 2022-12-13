import { type Options } from 'http-proxy-middleware';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { assign } from '@lzwme/fe-utils';
import { logger } from './get-logger';
import { ServerOptions } from 'node:https';

export interface SSConfig {
  /** 根目录 */
  baseDir?: string;
  /** 启动后是否打开首页 */
  open?: boolean;
  /** 监听端口号 */
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
  // {
  //   key: string | Buffer;
  //   cert: string | Buffer;
  // };
}

const ssConfig: SSConfig = {
  baseDir: '.',
  open: false,
  port: 8890,
  proxyConfig: [],
  log: false,
  ssl: {
    key: '',
    cert: '',
  },
};

export function getConfig(useCache = true, cfg?: SSConfig) {
  if (ssConfig.port && useCache) return ssConfig;

  const cfgFile = resolve(process.cwd(), './ss.config.js');
  if (existsSync(cfgFile)) assign(ssConfig, require(cfgFile));

  if (cfg) assign(ssConfig, cfg);

  if (ssConfig.log) {
    logger.setLogDir(typeof ssConfig.log === 'boolean' ? resolve(homedir(), '.sserver/log.log') : ssConfig.log);
  }
  if (ssConfig.https && ssConfig.ssl) {
    if (typeof ssConfig.ssl.key === 'string') ssConfig.ssl.key = readFileSync(ssConfig.ssl.key);
    if (typeof ssConfig.ssl!.cert === 'string') ssConfig.ssl.cert = readFileSync(ssConfig.ssl.cert);
  }

  return ssConfig;
}
