import { program } from 'commander';
import { color } from 'console-log-colors';
import { getConfig } from './config';
import { logger } from './get-logger';
import { initServer } from './static-server';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const pkg = require('../package.json');

program
  .aliases(['ss'])
  .version(pkg.version, '-v, --version')
  .description(color.yellow(pkg.description) + ` [version@${color.cyanBright(pkg.version)}]`)
  // .option('-c, --config-path [filepath]', `配置文件 ${color.yellow(config.configPath)} 的路径`)
  .option('-d, --base-dir [baseDir]', '静态服务器的根目录路径')
  .option('-p, --port [port]', '端口号')
  .option('-o, --open', '启动后是否打开静态服务器首页')
  .option('--log [dirpath]', `指定日志路径`)
  .option('--debug', `开启调试模式。`, false)
  .action(opts => {
    if (opts.debug) {
      logger.updateOptions({ levelType: 'debug' });
      logger.debug(opts);
    }

    initServer(getConfig(false, opts));
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
