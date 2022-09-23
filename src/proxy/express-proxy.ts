import { color } from 'console-log-colors';
import { type Express } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { getConfig } from '../config';
import { logger } from '../get-logger';

export function proxyByExpress(app: Express) {
  const { proxyConfig } = getConfig();
  if (!proxyConfig?.length) return;

  proxyConfig.forEach(({ api, config }) => {
    const onProxyReq = config.onProxyReq;
    config.onProxyReq = (pReq, req, res, options) => {
      const now = new Date();
      logger.log(
        now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0'),
        color.gray('[proxyReq]'),
        color.cyan(req.originalUrl),
        '=>',
        color.cyanBright(`${pReq.protocol}${pReq.host}${pReq.path}`)
      );

      if (onProxyReq) onProxyReq(pReq, req, res, options);
    };

    app.use(api, createProxyMiddleware(config));

    logger.log(`Init proxy for ${color.cyanBright(api)}`);
  });
}
