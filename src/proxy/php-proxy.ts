// @see https://www.npmjs.com/package/phpcgijs

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parse, type UrlWithStringQuery } from 'node:url';
import { promises, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NextFunction, Express, Request, Response } from 'express';
import { execSync, color } from '@lzwme/fe-utils';
import { type SSConfig } from '../config';
import { logger } from '../get-logger';

export async function phpProxy(app: Express, config: SSConfig) {
  return app.use('/', createPhpMiddleware(config.rootDir!, config.phpConfig));
}

let PHP_CGI: string;
function getPhpCgi() {
  if (PHP_CGI == null) {
    const which = process.platform === 'win32' ? 'where' : 'which';
    PHP_CGI = execSync(`${which} php-cgi`).stdout.trim() || execSync(`${which} php-cgi`).stdout.trim();
  }

  return PHP_CGI;
}

async function findPhpFile(pathname: string, rootDir: string) {
  let filepath = join(rootDir, pathname);

  if (!filepath.includes(rootDir) || !existsSync(filepath)) return false;

  let stat = await promises.stat(filepath);

  if (stat.isDirectory()) {
    filepath = join(filepath, 'index.php');
    if (!existsSync(filepath)) return false;
  }

  return filepath;
}

function formatArgs(args: Record<string, unknown>) {
  return Object.entries(args).map(([key, value]) => `${key.startsWith('-') ? key : `-${key}`} ${value}`);
}

function runPhpCgi(req: Request, response: Response, url: UrlWithStringQuery, filepath: string, phpConfig: SSConfig['phpConfig'], rootDir: string) {
  const pathname = url.pathname || req.url;
  const pathinfo = pathname.includes('.php') ? pathname.split('.php')[0] + '.php' : pathname;

  if (!phpConfig) return;

  const env: Record<string, string> = {
    SERVER_SIGNATURE: 'NodeJS server at localhost',
    // The extra path information, as given in the requested URL. In fact, scripts can be accessed by their virtual path, followed by extra information at the end of this path. The extra information is sent in PATH_INFO.
    PATH_INFO: pathinfo,
    // The virtual-to-real mapped version of PATH_INFO.
    PATH_TRANSLATED: '',
    // The virtual path of the script being executed.
    SCRIPT_NAME: pathname,
    SCRIPT_FILENAME: filepath,
    // The real path of the script being executed.
    REQUEST_FILENAME: filepath,
    // The full URL to the current object requested by the client.
    SCRIPT_URI: req.url,
    // The full URI of the current request. It is made of the concatenation of SCRIPT_NAME and PATH_INFO (if available.)
    URL: req.url,
    SCRIPT_URL: req.url,
    // The original request URI sent by the client.
    REQUEST_URI: req.url,
    // The method used by the current request; usually set to GET or POST.
    REQUEST_METHOD: req.method,
    // The information which follows the ? character in the requested URL.
    QUERY_STRING: url.query || '',
    // 'multipart/form-data', //'application/x-www-form-urlencoded', //The MIME type of the request body; set only for POST or PUT requests.
    CONTENT_TYPE: req.get('Content-Type') || '',
    // The length in bytes of the request body; set only for POST or PUT requests.
    CONTENT_LENGTH: req.get('Content-Length') || '0',
    // The authentication type if the client has authenticated itself to access the script.
    AUTH_TYPE: '',
    AUTH_USER: '',
    // The name of the user as issued by the client when authenticating itself to access the script.
    REMOTE_USER: '',
    // All HTTP headers sent by the client. Headers are separated by carriage return characters (ASCII 13 - \n) and each header name is prefixed by HTTP_, transformed to upper cases, and - characters it contains are replaced by _ characters.
    ALL_HTTP: Object.entries(req.headers)
      .map(([key, value]) => `HTTP__${key.toUpperCase().replace('-', '_')}: ${value}`)
      .reduce((a, b) => a + b + '\n', ''),
    // All HTTP headers as sent by the client in raw form. No transformation on the header names is applied.
    ALL_RAW: Object.entries(req.headers)
      .map(([key, value]) => `${key}: value`)
      .reduce((a, b) => a + b + '\n', ''),
    // The web server's software identity.
    SERVER_SOFTWARE: 'NodeJS SServer',
    // The host name or the IP address of the computer running the web server as given in the requested URL.
    SERVER_NAME: 'localhost',
    // The IP address of the computer running the web server.
    SERVER_ADDR: '127.0.0.1',
    // The port to which the request was sent.
    SERVER_PORT: String(phpConfig.port || '9010'),
    // The CGI Specification version supported by the web server; always set to CGI/1.1.
    GATEWAY_INTERFACE: 'CGI/1.1',
    // The HTTP protocol version used by the current request.
    SERVER_PROTOCOL: '',
    // The IP address of the computer that sent the request.
    REMOTE_ADDR: req.ip || '',
    // The port from which the request was sent.
    REMOTE_PORT: '',
    // The absolute path of the web site files. It has the same value as Documents Path.
    DOCUMENT_ROOT: rootDir,
    // The numerical identifier of the host which served the request. On Abyss Web Server X1, it is always set to 1 since there is only a single host.
    INSTANCE_ID: '',
    // The virtual path of the deepest alias which contains the request URI. If no alias contains the request URI, the variable is set to /.
    APPL_MD_PATH: '',
    // The real path of the deepest alias which contains the request URI. If no alias contains the request URI, the variable is set to the same value as DOCUMENT_ROOT.
    APPL_PHYSICAL_PATH: '',
    // It is set to true if the current request is a subrequest, i.e. a request not directly invoked by a client. Otherwise, it is set to true. Subrequests are generated by the server for internal processing. XSSI includes for example result in subrequests.
    IS_SUBREQ: '',
    REDIRECT_STATUS: '1',
  };

  Object.entries(req.headers).forEach(function ([key, value]) {
    env['HTTP_' + key.toUpperCase().replace('-', '_')] = value as string;
  });

  if (filepath.endsWith('.php')) {
    let childProc: ChildProcessWithoutNullStreams;
    const cgiArgs = formatArgs(phpConfig.args!);
    let cgipath = phpConfig.cgiPath || getPhpCgi();
    let res = '';
    let err = '';

    if (!cgipath || !existsSync(cgipath)) throw new Error('"php-cgi" cannot be found');

    childProc = spawn(cgipath, cgiArgs, { env });

    // php.stdin.resume();
    // logger.debug(req.rawBody);
    // (new Stream(req.rawBody)).pipe(php.stdin);
    // php.stdin.write('\n');
    // php.stdin.end();

    // pipe request stream directly into the php process
    req.pipe(childProc.stdin);

    childProc.stdin.on('error', () => {
      logger.error('[php]Error from server');
    });
    childProc.stdout.on('data', (data) => {
      res += data.toString();
    });
    childProc.stderr.on('data', (data) => {
      err += data.toString();
    });
    childProc.on('error', (err) => {
      logger.error('error', err);
    });
    childProc.on('exit', () => {
      childProc.stdin.end();

      const lines = res ? res.split('\r\n') : [];
      let line = 0;
      let body = '';

      if (lines.length) {
        do {
          const m = lines[line].split(': ');
          if (m[0] === '') break;
          if (m[0] == 'Status') {
            response.statusCode = parseInt(m[1]);
          }
          if (m.length == 2) {
            response.setHeader(m[0], m[1]);
          }
          line++;
        } while (lines[line] !== '');

        body = lines.splice(line + 1).join('\n');
      } else {
        body = res || err;
      }

      logger.debug('[php]STATUS: ', response.statusCode);

      response.status(response.statusCode).end(body);
    });
  } else {
    response.sendFile(filepath);
  }
}

function createPhpMiddleware(rootDir: string, phpConfig: SSConfig['phpConfig'] = {}) {
  return async function phpMiddleware(req: Request, res: Response, next: NextFunction) {
    // stop stream until child-process is opened
    req.pause();

    const url = parse(req.url);
    const filepath = await findPhpFile(url.pathname || req.path, rootDir);

    if (filepath && (filepath.includes('.php') || phpConfig.onlyPhpFile === false)) {
      logger.info('[php][exec]', color.green(req.path), '=>', color.yellow(filepath));
      runPhpCgi(req, res, url, filepath, phpConfig, rootDir);
      req.resume();
    } else {
      req.resume();
      next();
    }
  };
}
