import { type Options } from 'http-proxy-middleware';
import { resolve } from 'path';
import { execSync } from 'child_process';

export interface SSConfig {
  /** 根目录 */
  baseDir?: string;
  /** 启动后是否打开首页 */
  open?: boolean;
  /** 监听端口号 */
  port?: number;
  /** 代理转发配置 */
  proxyConfig?: { api: string; config: Options }[];
}

const ssConfig: SSConfig = {
  baseDir: '.',
  open: false,
  port: 8890,
  proxyConfig: [],
};

export function getConfig(useCache = true, cfg?: SSConfig) {
  if (ssConfig.port && useCache) return ssConfig;

  const cfgFile = resolve(process.cwd(), './ss.config.js');
  if (execSync(cfgFile)) Object.assign(ssConfig, require(cfgFile));

  if (cfg) Object.assign(ssConfig, cfg);

  return ssConfig;
}
