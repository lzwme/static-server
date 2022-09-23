import net from 'node:net';
import { log } from 'console-log-colors';

export function socketProxy(
  config = {
    // 外网访问的端口
    localPort: 3717,
    // 代理转发的端口
    remotePort: 27017,
    //代理转发的 IP 地址
    remoteHost: '127.0.0.1',
  }
) {
  const server = net
    .createServer(socket => {
      log.green('proxy for address', socket.address());

      let to = net.createConnection({
        host: config.remoteHost,
        port: config.remotePort,
      });
      socket.pipe(to);
      to.pipe(socket);
    })
    .listen(config.localPort);

  return server;
}
