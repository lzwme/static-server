/*
 * @Author: lzw
 * @Date: 2021-05-28 16:24:40
 * @LastEditors: lzw
 * @LastEditTime: 2022-09-23 17:21:36
 * @Description:
 */

import { resolve } from 'node:path';
import { createServer, type ServerOptions } from 'node:https';
import { color } from 'console-log-colors';
import express, { type Express } from 'express';
import { execSync } from 'child_process';
import { getConfig, SSConfig } from './config';
import { proxyByExpress } from './proxy/express-proxy';
import { logger } from './get-logger';
import { assign } from '@lzwme/fe-utils';

export async function initServer(c?: SSConfig): Promise<Express> {
  const config = await getConfig(!c, c);

  const app = express();
  const { port = 8888, host = 'localhost' } = config;
  const url = `http${config.https ? 's' : ''}://${host}:${port}`;
  const rootDir = resolve(process.cwd(), typeof config.rootDir === 'string' ? config.rootDir : '.');

  // app.use((_req, res, next) => {
  //   Object.entries(config.headers!).forEach(([key, value]) => res.header(key, value));
  //   next();
  // });

  // @see https://www.expressjs.com.cn/4x/api.html#express.static
  app.use(
    express.static(rootDir, {
      extensions: ['html', 'htm'],
      setHeaders: (res, path, stat) => {
        const headers = { ...config.headers };
        if (typeof config.setHeaders === 'function') assign(headers, config.setHeaders(res, path, stat));
        logger.debug('[setHeader]', path, headers);
        Object.entries(headers).forEach(([key, value]) => res.header(key, value));
      },
    })
  );

  await proxyByExpress(app);

  const onListen = () => {
    logger.log(color.green(`START : `.padStart(15, ' ')), color.cyanBright(url));
    logger.log(color.green(`ROOT DIR : `.padStart(15, ' ')), color.cyanBright(rootDir));
  };

  if (config.https) {
    createServer(config.ssl!, app).listen(port, onListen);
  } else {
    app.listen(port, onListen);
  }

  logger.debug(config);

  if (config.open) {
    const openPageCmd = `${process.platform === 'win32' ? `start` : `open`} ${url}`;
    execSync(openPageCmd);
  }

  return app;
}
