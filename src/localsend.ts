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
import express, { type Express, type Request, type Response } from 'express';
import multer from 'multer';
import { getConfig } from './config';
import { logger } from './get-logger';
import { createGuard } from './lib/localsend-guard';
import { getIp } from './lib/utils';

/**
 * 前端页面单文件路径（相对本模块）。
 * 构建后页面位于 dist/localsend/index.html；dev（ts-node）运行时位于 src/localsend/index.html。
 */
const PAGE_REL_PATH = './localsend/index.html';

/** 页面静态资源目录（相对本模块），与 PAGE_REL_PATH 同级 */
const PAGE_DIR = './localsend';

/** 去除文件名中的路径分隔符，防止目录穿越。非法返回空串 */
function safeName(name?: unknown) {
  const n = basename(String(name || '').trim());
  if (!n || n === '.' || n === '..' || n.includes('/') || n.includes('\\')) return '';
  return n;
}

/** 严格解码字节，编码不匹配时返回 null */
function decodeStrict(bytes: Buffer, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 修复 multipart 上传的文件名乱码。
 *
 * 浏览器（WHATWG 规范）会把文件名的 UTF-8 原始字节直接写进 Content-Disposition 的 filename 参数，
 * 而 busboy 默认按 latin1（defParamCharset='latin1'）解码该参数，中文文件名就会变成乱码
 * （如 `中文.txt` → `ä¸­æ–‡.txt`）。
 *
 * 这里保留原始字节（latin1 与字节一一对应，可无损还原），再按 utf-8 / gb18030 依次尝试严格解码：
 *  - UTF-8 是浏览器的标准行为；
 *  - gb18030 兼容部分国产客户端 / 老程序用 GBK 发送文件名的情况。
 */
export function decodeUploadName(raw?: unknown): string {
  const name = String(raw || '');
  if (!name) return '';
  // 含有 latin1 之外的字符，说明文件名已被正确解码过（如 RFC2231 的 filename*），直接使用
  if ([...name].some((c) => c.charCodeAt(0) > 255)) return name;
  const bytes = Buffer.from(name, 'latin1');
  for (const encoding of ['utf-8', 'gb18030']) {
    const decoded = decodeStrict(bytes, encoding);
    if (decoded !== null && decoded !== name) return decoded;
  }
  return name;
}

/**
 * 修复历史上已上传的乱码文件名（把 UTF-8 字节误存成 latin1 字符导致的乱码）。
 * 返回被重命名的 [旧名, 新名] 列表。
 */
export function repairLocalsendNames(dir: string): [string, string][] {
  const renamed: [string, string][] = [];
  if (!existsSync(dir)) return renamed;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    if ([...name].some((c) => c.charCodeAt(0) > 255)) continue; // 已是正常文件名
    const decoded = decodeStrict(Buffer.from(name, 'latin1'), 'utf-8');
    if (decoded === null || decoded === name) continue; // 非乱码
    // 目标名已存在时按 _1/_2 追加后缀，避免覆盖同名文件
    const target = uniqueName(dir, decoded);
    try {
      renameSync(full, join(dir, target));
      renamed.push([name, target]);
    } catch (err) {
      logger.error('[localsend 修复文件名]', err);
    }
  }
  return renamed;
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

/**
 * 计算目录下所有文件的总大小（字节）。忽略读取失败的条目。
 */
export function dirSize(target: string): number {
  if (!existsSync(target)) return 0;
  let total = 0;
  for (const name of readdirSync(target)) {
    try {
      const stat = statSync(join(target, name));
      if (stat.isFile()) total += stat.size;
    } catch {
      // 文件可能刚好被删除，跳过
    }
  }
  return total;
}

export async function initLocalsend(app: Express): Promise<void> {
  const config = await getConfig();
  const raw = config.localsend;
  if (!raw) return;

  const ls = typeof raw === 'boolean' ? { enabled: raw } : raw;
  if (!ls.enabled) return;

  const dir = ls.dir || '';
  const maxSize = ls.maxSize || 1024 * 1024 * 1024;
  const maxTotalSize = ls.maxTotalSize || 0;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // 访问防护：令牌 / 频率限制 / 并发限制
  const guard = createGuard({
    token: ls.token,
    maxConcurrent: ls.maxConcurrent,
    rateLimit: ls.rateLimit,
  });

  const port = config.port || 80;
  const ipUrl = `http://${getIp() || 'localhost'}:${port}`;
  // 配置了令牌时，把令牌带上，方便直接扫码访问
  const keyQuery = ls.token ? `?key=${encodeURIComponent(ls.token)}` : '';
  logger.log(color.green('LocalSend : '.padStart(15, ' ')), color.greenBright('局域网文件传输功能已开启'));
  logger.log(color.green('LocalSend DIR : '.padStart(15, ' ')), color.cyanBright(dir));
  logger.log(color.green('LocalSend URL : '.padStart(15, ' ')), color.cyanBright(`${ipUrl}/localsend${keyQuery}`));
  if (ls.token) logger.log(color.green('LocalSend KEY : '.padStart(15, ' ')), color.yellowBright('已启用访问令牌'));

  // 访问令牌校验（配置了 token 才生效），覆盖页面与所有接口
  app.use('/localsend', guard.requireToken);
  // 接口频率限制
  app.use('/localsend/api', guard.rateLimit);

  // 页面：初始化时读入独立 html 单文件
  const pageHtml = readFileSync(resolve(__dirname, PAGE_REL_PATH), 'utf8');
  app.get('/localsend', (_req: Request, res: Response) => {
    res.type('html').send(pageHtml);
  });

  // 页面静态资源（样式、二维码库、图标等）：与页面同目录，供离线局域网使用
  app.use(
    '/localsend',
    express.static(resolve(__dirname, PAGE_DIR), {
      index: false,
      maxAge: '1h',
    }),
  );

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
    // 显式声明按 latin1 读取 Content-Disposition 参数，保留文件名的原始字节，
    // 再由 decodeUploadName 按 utf-8 / gb18030 解码，避免中文文件名乱码
    defParamCharset: 'latin1',
  });
  app.post(
    '/localsend/api/upload',
    // 单 IP 并发上传数限制
    guard.limitConcurrent,
    // 总容量预检：目录已用容量与本次请求体大小共同判断，超出配额直接拒绝
    (req: Request, res: Response, next) => {
      if (!maxTotalSize) return next();
      const used = dirSize(dir);
      if (used >= maxTotalSize) {
        res.status(413).json({
          code: 1,
          msg: `存储空间已满：${(used / 1024 / 1024).toFixed(1)}MB / ${(maxTotalSize / 1024 / 1024).toFixed(1)}MB`,
        });
        return;
      }
      // multipart 请求体的 Content-Length 包含少量协议开销，作为保守估计
      const need = Number(req.get('Content-Length') || 0);
      if (need > 0 && used + need > maxTotalSize) {
        res.status(413).json({
          code: 1,
          msg: `剩余容量不足：已用 ${(used / 1024 / 1024).toFixed(1)}MB，本次需要约 ${(need / 1024 / 1024).toFixed(1)}MB`,
        });
        return;
      }
      next();
    },
    upload.array('files'),
    (req: Request, res: Response) => {
      const files = (req.files || []) as Express.Multer.File[];
      const results: { name: string; size: number }[] = [];
      const errors: string[] = [];

      for (const f of files) {
        try {
          const name = uniqueName(dir, safeName(decodeUploadName(f.originalname)) || `file_${Date.now()}`);
          renameSync(f.path, join(dir, name));
          results.push({ name, size: f.size });
        } catch (err) {
          logger.error('[localsend upload]', err);
          errors.push(f.originalname || '');
        }
      }

      // 容量复核：写入后若超出总配额，撤销本次写入并提示
      if (maxTotalSize && dirSize(dir) > maxTotalSize) {
        for (const r of results) {
          try {
            rmSync(join(dir, r.name));
          } catch {
            // 忽略删除失败
          }
        }
        res.status(413).json({ code: 1, msg: '存储容量不足，本次上传已撤销' });
        return;
      }

      res.json({ code: 0, data: { results, errors } });
    },
  );

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
