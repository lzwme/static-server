/* eslint-disable no-console */
/*
 * @Author: lzw
 * @Date: 2021-05-28 16:24:40
 * @LastEditors: lzw
 * @LastEditTime: 2022-07-01 17:07:39
 * @Description:
 */

import { color } from 'console-log-colors';
import express from 'express';
import { execSync } from 'child_process';
import { getConfig, SSConfig } from './config';
import { proxyByExpress } from './proxy/express-proxy';

export const initServer = (options?: SSConfig) => {
  options = getConfig(true, options);

  const { baseDir = '.', port = 8890 } = options;
  const app = express();

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
