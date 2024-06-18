/*
 * @Author: lzw
 * @Date: 2021-05-28 16:24:40
 * @LastEditors: renxia
 * @LastEditTime: 2024-06-18 11:25:13
 * @Description:
 */

import { createServer } from 'node:https';
import { execSync } from 'node:child_process';
import { color } from 'console-log-colors';
import express, { type Express } from 'express';
import { assign } from '@lzwme/fe-utils';
import { getConfig, type SSConfig } from './config';
import { logger } from './get-logger';
import { proxyByExpress } from './proxy/express-proxy';
import { phpProxy } from './proxy/php-proxy';
import { getIp } from './lib/utils.js';

export async function initServer(c?: SSConfig): Promise<Express> {
  const app = express();
  const config = await getConfig(!c, c);
  const { rootDir = '.', port = 8888, host = 'localhost' } = config;
  const url = `http${config.https ? 's' : ''}://${host}:${port}`;
  const ipUrl = `http://${getIp()}:${port}`;

  app.use((req, res, next) => {
    if (config.cors) config.headers!['Access-Control-Allow-Origin'] = req.header('origin') || '*';
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

  if (config.autoindex) {
    // @ts-expect-error
    const serveIndex = await import('serve-index');
    app.use(
      serveIndex.default(rootDir, {
        icons: true,
        hidden: true,
      })
    );
  }

  const onListen = () => {
    logger.log(color.green(`ROOT DIR : `.padStart(15, ' ')), color.greenBright(rootDir));
    logger.log(color.green(`Local/Host : `.padStart(15, ' ')), color.cyanBright(url));
    logger.log(color.green(`Network[IP] : `.padStart(15, ' ')), color.cyanBright(ipUrl));
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
