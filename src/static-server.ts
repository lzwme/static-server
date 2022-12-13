/*
 * @Author: lzw
 * @Date: 2021-05-28 16:24:40
 * @LastEditors: lzw
 * @LastEditTime: 2022-09-23 17:21:36
 * @Description:
 */

import { resolve } from 'node:path';
import { color } from 'console-log-colors';
import express, { type Express } from 'express';
import { execSync } from 'child_process';
import { getConfig, SSConfig } from './config';
import { proxyByExpress } from './proxy/express-proxy';
import { logger } from './get-logger';

export function initServer(options?: SSConfig): Express {
  options = getConfig(true, options);

  const app = express();
  const { port = 8890, host = '127.0.0.1' } = options;
  const url = `http://${host}:${port}`;
  const baseDir = resolve(process.cwd(), typeof options.baseDir === 'string' ? options.baseDir : '.');

  // @see https://www.expressjs.com.cn/4x/api.html#express.static
  app.use(
    express.static(baseDir, {
      // extensions: ['html', 'htm'],
    })
  );

  proxyByExpress(app);
  app.listen(port, () => {
    logger.log(color.green(`Start : `.padStart(15, ' ')), color.cyanBright(url));
    logger.log(color.green(`ROOT DIR : `.padStart(15, ' ')), color.cyanBright(baseDir));
  });

  logger.debug(options);

  if (options.open) {
    const openPageCmd = `${process.platform === 'win32' ? `start` : `open`} ${url}`;
    execSync(openPageCmd);
  }

  return app;
}
