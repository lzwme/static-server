/*
 * LocalSend 局域网文件传输服务端模块
 * 路由：
 *  - GET    /localsend                   页面
 *  - GET    /localsend/api/list          文件列表（支持 ?sort=time|size&order=asc|desc）
 *  - POST   /localsend/api/upload        多文件上传（multipart，字段名 files）
 *  - GET    /localsend/api/download/:name  下载（attachment）
 *  - GET    /localsend/api/preview/:name   预览（inline）
 *  - DELETE /localsend/api/delete/:name    删除
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { color } from 'console-log-colors';
import type { Express, Request, Response } from 'express';
import multer from 'multer';
import { getConfig } from './config';
import { logger } from './get-logger';
import { getIp } from './lib/utils';

/**
 * 前端页面单文件路径（相对本模块）。
 * 构建后页面位于 dist/localsend/index.html；dev（ts-node）运行时位于 src/localsend/index.html。
 */
const PAGE_REL_PATH = './localsend/index.html';

/** 去除文件名中的路径分隔符，防止目录穿越。非法返回空串 */
function safeName(name?: unknown) {
  const n = basename(String(name || '').trim());
  if (!n || n === '.' || n === '..' || n.includes('/') || n.includes('\\')) return '';
  return n;
}

/** 同名文件自动追加 _1/_2 后缀 */
function uniqueName(targetDir: string, name: string) {
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  let finalName = name;
  let i = 1;
  while (existsSync(join(targetDir, finalName))) {
    finalName = `${base}_${i}${ext}`;
    i += 1;
  }
  return finalName;
}

export async function initLocalsend(app: Express): Promise<void> {
  const config = await getConfig();
  const raw = config.localsend;
  if (!raw) return;

  const ls = typeof raw === 'boolean' ? { enabled: raw } : raw;
  if (!ls.enabled) return;

  const dir = ls.dir || '';
  const maxSize = ls.maxSize || 1024 * 1024 * 1024;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const port = config.port || 80;
  const ipUrl = `http://${getIp() || 'localhost'}:${port}`;
  logger.log(color.green('LocalSend : '.padStart(15, ' ')), color.greenBright('局域网文件传输功能已开启'));
  logger.log(color.green('LocalSend DIR : '.padStart(15, ' ')), color.cyanBright(dir));
  logger.log(color.green('LocalSend URL : '.padStart(15, ' ')), color.cyanBright(`${ipUrl}/localsend`));

  // 页面：初始化时读入独立 html 单文件
  const pageHtml = readFileSync(resolve(__dirname, PAGE_REL_PATH), 'utf8');
  app.get('/localsend', (_req: Request, res: Response) => {
    res.type('html').send(pageHtml);
  });

  // 文件列表
  app.get('/localsend/api/list', (req: Request, res: Response) => {
    const sort = String(req.query.sort || 'time');
    const asc = String(req.query.order || 'desc') !== 'desc';
    const list = readdirSync(dir)
      .map((name) => {
        const full = join(dir, name);
        const stat = statSync(full);
        return {
          name,
          size: stat.size,
          mtime: stat.mtimeMs,
          ext: extname(name).slice(1),
          isDir: stat.isDirectory(),
        };
      })
      .filter((item) => !item.isDir);
    list.sort((a, b) => (sort === 'size' ? (asc ? a.size - b.size : b.size - a.size) : asc ? a.mtime - b.mtime : b.mtime - a.mtime));
    res.json({ code: 0, data: list });
  });

  // 多文件上传
  const upload = multer({
    dest: dir,
    limits: { fileSize: maxSize, files: 200 },
  });
  app.post('/localsend/api/upload', upload.array('files'), (req: Request, res: Response) => {
    const files = (req.files || []) as Express.Multer.File[];
    const results: { name: string; size: number }[] = [];
    const errors: string[] = [];

    for (const f of files) {
      try {
        const name = uniqueName(dir, safeName(f.originalname) || `file_${Date.now()}`);
        renameSync(f.path, join(dir, name));
        results.push({ name, size: f.size });
      } catch (err) {
        logger.error('[localsend upload]', err);
        errors.push(f.originalname || '');
      }
    }

    res.json({ code: 0, data: { results, errors } });
  });

  // 下载。dotfiles: 'allow' 以兼容 ~/.static-server 这类隐藏目录作为存储目录
  app.get('/localsend/api/download/:name', (req: Request, res: Response) => {
    const name = safeName(req.params.name);
    if (!name) return void res.status(400).json({ code: 1, msg: '非法的文件名' });
    const filePath = resolve(dir, name);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return void res.status(404).json({ code: 1, msg: '文件不存在' });
    }
    res.download(filePath, name, { dotfiles: 'allow' });
  });

  // 预览（inline 方式返回，浏览器可直读图片/文本等）
  app.get('/localsend/api/preview/:name', (req: Request, res: Response) => {
    const name = safeName(req.params.name);
    if (!name) return void res.status(400).json({ code: 1, msg: '非法的文件名' });
    const filePath = resolve(dir, name);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return void res.status(404).json({ code: 1, msg: '文件不存在' });
    }
    res.sendFile(filePath, {
      dotfiles: 'allow',
      headers: { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}` },
    });
  });

  // 删除
  app.delete('/localsend/api/delete/:name', (req: Request, res: Response) => {
    const name = safeName(req.params.name);
    if (!name) return void res.status(400).json({ code: 1, msg: '非法的文件名' });
    const filePath = resolve(dir, name);
    if (!existsSync(filePath)) return void res.status(404).json({ code: 1, msg: '文件不存在' });
    rmSync(filePath);
    res.json({ code: 0 });
  });
}
