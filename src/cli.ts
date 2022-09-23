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

program.parse(process.argv);
