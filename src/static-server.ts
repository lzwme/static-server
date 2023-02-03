/*
 * @Author: lzw
 * @Date: 2021-05-28 16:24:40
 * @LastEditors: lzw
 * @LastEditTime: 2023-02-03 13:32:07
 * @Description:
 */

import { createServer } from 'node:https';
import { color } from 'console-log-colors';
import express, { type Express } from 'express';
import { execSync } from 'child_process';
import { assign } from '@lzwme/fe-utils';
import { getConfig, SSConfig } from './config';
import { logger } from './get-logger';
import { proxyByExpress } from './proxy/express-proxy';
import { phpProxy } from './proxy/php-proxy';

export async function initServer(c?: SSConfig): Promise<Express> {
  const app = express();
  const config = await getConfig(!c, c);
  const { rootDir = '.', port = 8888, host = 'localhost' } = config;
  const url = `http${config.https ? 's' : ''}://${host}:${port}`;

  app.use((_req, res, next) => {
    Object.entries(config.headers!).forEach(([key, value]) => res.header(key, value));
    next();
  });

  if (typeof config.custom === 'function') {
    await config.custom(app, config, logger, color);
  }

  await phpProxy(app, config);
  await proxyByExpress(app);

  // @see https://www.expressjs.com.cn/4x/api.html#express.static
  app.use(
    express.static(rootDir, {
      extensions: ['html', 'htm'],
      setHeaders: (res, path, stat) => {
        if (typeof config.setHeaders === 'function') {
          const headers = { ...config.headers };
          logger.debug('[setHeader]', path, headers);
          assign(headers, config.setHeaders(res, path, stat));
          Object.entries(headers).forEach(([key, value]) => res.header(key, value));
        }
      },
    })
  );

  const onListen = () => {
    logger.log(color.green(`Runing at : `.padStart(15, ' ')), color.cyanBright(url));
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
