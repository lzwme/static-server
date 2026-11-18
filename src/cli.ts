import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { program } from 'commander';
import { color } from 'console-log-colors';
import { getConfig } from './config';
import { logger } from './get-logger';
import { repairLocalsendNames } from './localsend';
import { initServer } from './static-server';

const pkg = require('../package.json');

program
  .aliases(['ss'])
  .version(pkg.version, '-v, --version')
  .description(`${color.yellow(pkg.description)} [version@${color.cyanBright(pkg.version)}]`)
  // .option('-c, --config-path [filepath]', `配置文件 ${color.yellow(config.configPath)} 的路径`)
  .option('-d, --root-dir [dirpath]', '静态服务器的根目录路径')
  .option('-a, --autoindex', '是否开启目录列表浏览')
  .option('-p, --port [port]', '端口号')
  .option('--host <hostname>', '域名。默认为 `localhost`')
  .option('-H, --https', '启用 https 模式')
  .option('--cert <filepath>', 'https 模式使用的 ssl cert。默认根据 host 随机生成')
  .option('--key <filepath>', 'https 模式使用的 ssl key。默认根据 host 随机生成')
  .option('--ssl-cache <dir>', '随机生成 cert 证书缓存的路径。未指定则不缓存')
  .option('-o, --open', '启动后是否打开静态服务器首页')
  .option('--coop-coep', '启用跨域隔离', false)
  .option('--cors', '是否启用 cors。会全局设置 cors 的 header')
  .option('--no-cors', '是否禁用 cors')
  .option('--log [dirpath]', `指定日志路径`)
  .option('--localsend', '开启 localsend 局域网文件传输功能')
  .option('--localsend-dir <dir>', 'localsend 文件存储目录。默认 ~/.static-server/localsend，可用环境变量 SS_LOCALSEND_DIR 覆盖')
  .option('--debug', `开启调试模式。`, false)
  .action(async (opts) => {
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

    if (opts.localsend) {
      opts.localsend = { enabled: true, dir: opts.localsendDir || undefined };
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

program
  .command('fix-localsend-names')
  .description('修复 localsend 存储目录中因编码问题产生的乱码文件名')
  .option('--localsend-dir <dir>', 'localsend 文件存储目录。默认使用配置中的目录')
  .action(async (opts) => {
    const config = await getConfig(false, opts.localsendDir ? { localsend: { enabled: true, dir: opts.localsendDir } } : {});
    const ls = typeof config.localsend === 'object' && config.localsend ? config.localsend : {};
    const dir = opts.localsendDir || ls.dir || process.env.SS_LOCALSEND_DIR || resolve(homedir(), '.static-server/localsend');

    const renamed = repairLocalsendNames(dir);
    if (!renamed.length) {
      logger.info('未发现乱码文件名。目录：', color.cyanBright(dir));
      return;
    }
    for (const [from, to] of renamed) logger.info(`已重命名：${color.yellow(from)} → ${color.greenBright(to)}`);
    logger.info(`共修复 ${color.cyanBright(renamed.length)} 个文件名。目录：`, color.cyanBright(dir));
  });

program.parse(process.argv);
