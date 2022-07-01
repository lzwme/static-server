/* eslint-disable no-console */
/*
 * @Author: lzw
 * @Date: 2021-05-28 16:24:40
 * @LastEditors: lzw
 * @LastEditTime: 2022-07-01 17:43:51
 * @Description:
 */

import { color } from 'console-log-colors';
import express, { type Express } from 'express';
import { execSync } from 'child_process';
import { getConfig, SSConfig } from './config';
import { proxyByExpress } from './proxy/express-proxy';

export function initServer(options?: SSConfig): Express {
  options = getConfig(true, options);

  const app = express();
  const { baseDir = '.', port = 8890 } = options;

  // @see https://www.expressjs.com.cn/4x/api.html#express.static
  app.use(express.static(baseDir));

  proxyByExpress(app);

  app.listen(port, () => {
    console.log(color.green(`Static server Listening Port:`), port);
    console.log(color.green(`Static DIR:`), color.cyanBright(baseDir));
  });

  if (options.open !== false) {
    const openPageCmd = `${process.platform === 'win32' ? `start` : `open`} http://localhost:${port}`;
    execSync(openPageCmd);
  }

  return app;
};
