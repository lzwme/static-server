import { program } from 'commander';
import chalk from 'chalk';
import { initServer } from '../src/static-server';

const pkg = require('../package.json');

program
  .aliases(['ss'])
  .version(pkg.version, '-v, --version')
  .description(chalk.yellow(pkg.description) + ` [version@${chalk.cyanBright(pkg.version)}]`)
  // .option('-c, --config-path [filepath]', `配置文件 ${chalk.yellow(config.configPath)} 的路径`)
  .option('-d, --base-dir [baseDir]', '静态服务器的根目录路径')
  .option('-p, --port [port]', '端口号')
  .option('-o, --open', '启动后是否打开静态服务器首页')
  .option('--debug', `开启调试模式。`, false)
  .action(opts => {
    if (opts.debug) console.log(opts);

    initServer(opts);
  });

program.parse(process.argv);
