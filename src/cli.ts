import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { program } from 'commander';
import { color } from 'console-log-colors';
import { getConfig } from './config';
import { logger } from './get-logger';
import { initServer } from './static-server';

const pkg = require('../package.json');

program
  .aliases(['ss'])
  .version(pkg.version, '-v, --version')
  .description(color.yellow(pkg.description) + ` [version@${color.cyanBright(pkg.version)}]`)
  // .option('-c, --config-path [filepath]', `配置文件 ${color.yellow(config.configPath)} 的路径`)
  .option('-d, --root-dir [dirpath]', '静态服务器的根目录路径')
  .option('-p, --port [port]', '端口号')
  .option('--host <hostname>', '域名。默认为 `localhost`')
  .option('-H, --https', '启用 https 模式')
  .option('--cert <filepath>', 'https 模式使用的 ssl cert。默认根据 host 随机生成')
  .option('--key <filepath>', 'https 模式使用的 ssl key。默认根据 host 随机生成')
  .option('--ssl-cache <dir>', '随机生成 cert 证书缓存的路径。未指定则不缓存')
  .option('-o, --open', '启动后是否打开静态服务器首页')
  .option('--coop-coep', '启用跨域隔离', false)
  .option('--log [dirpath]', `指定日志路径`)
  .option('--debug', `开启调试模式。`, false)
  .action(async opts => {
    if (opts.cert) opts.ssl.cert = opts.cert;
    if (opts.key) opts.ssl.key = opts.key;

    if (opts.debug) {
      logger.updateOptions({ levelType: 'debug' });
      logger.debug(opts);
    }

    if (opts.coopCoep) {
      opts.headers = {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      };
    }

    getConfig(false, opts).then(() => initServer());
  });

program
  .command('init [destination]')
  .description('初始化一个 ss.config.js 文件至指定的目录。默认为当前目录')
  .action((destination = process.cwd()) => {
    const confFile = resolve(destination, 'ss.config.js');
    if (existsSync(confFile)) {
      logger.warn('配置文件已存在，请确认：', color.cyanBright(confFile));
      return;
    }

    const tplFile = resolve(__dirname, '../ss.config.sample.js');
    if (!existsSync(tplFile)) {
      logger.error('未找到配置文件模板：', color.red(tplFile));
      return;
    }

    writeFileSync(confFile, readFileSync(tplFile));
    logger.info('已生成配置文件：', color.greenBright(confFile));
  });

program.parse(process.argv);
