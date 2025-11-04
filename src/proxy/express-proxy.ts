import { color } from 'console-log-colors';
import { type Express } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { getConfig } from '../config';
import { logger } from '../get-logger';

export async function proxyByExpress(app: Express) {
  const { proxyConfig } = await getConfig();
  if (!proxyConfig?.length) return;

  proxyConfig.forEach(({ api, config }) => {
    // @ts-ignore 兼容 2.0 api
    const onProxyReq = config.on?.proxyReq || config.onProxyReq;

    config.on = {
      ...(config.on || {}),
      proxyReq: (pReq, req, res, options) => {
        const now = new Date();
        logger.log(
          now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0'),
          color.gray('[proxyReq]'),
          color.cyan(req.url),
          '=>',
          color.cyanBright(`${pReq.protocol}${pReq.host}${pReq.path}`)
        );

        if (onProxyReq) onProxyReq(pReq, req, res, options);
      },
    };

    app.use(api, createProxyMiddleware(config));

    logger.log(`Init proxy for ${color.cyanBright(api)}`);
  });
}
