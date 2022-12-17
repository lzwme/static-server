/*
 * @Author: lzw
 * @Date: 2021-05-28 16:24:40
 * @LastEditors: lzw
 * @LastEditTime: 2022-09-23 17:21:36
 * @Description:
 */

import { resolve } from 'node:path';
import { createServer } from 'node:https';
import { color } from 'console-log-colors';
import express, { type Express } from 'express';
import { execSync } from 'child_process';
import { getConfig, SSConfig } from './config';
import { proxyByExpress } from './proxy/express-proxy';
import { logger } from './get-logger';
import { getCert } from './lib/get-cert';

export async function initServer(options?: SSConfig): Promise<Express> {
  options = getConfig(true, options);

  const app = express();
  const { port = 8890, host = 'localhost' } = options;
  const url = `http${options.https ? 's' : ''}://${host}:${port}`;
  const baseDir = resolve(process.cwd(), typeof options.baseDir === 'string' ? options.baseDir : '.');

  if (options.https && !options.ssl!.cert) {
    const info = await getCert(host);
    options.ssl!.key = Buffer.from(info.certKey);
    options.ssl!.cert = Buffer.from(info.certCrt);
  }

  // @see https://www.expressjs.com.cn/4x/api.html#express.static
  app.use(
    express.static(baseDir, {
      // extensions: ['html', 'htm'],
    })
  );

  proxyByExpress(app);

  const onListen = () => {
    logger.log(color.green(`Start : `.padStart(15, ' ')), color.cyanBright(url));
    logger.log(color.green(`ROOT DIR : `.padStart(15, ' ')), color.cyanBright(baseDir));
  };

  if (options.https) {
    createServer(options.ssl!, app).listen(port, onListen);
  } else {
    app.listen(port, onListen);
  }

  logger.debug(options);

  if (options.open) {
    const openPageCmd = `${process.platform === 'win32' ? `start` : `open`} ${url}`;
    execSync(openPageCmd);
  }

  return app;
}
