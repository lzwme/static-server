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

import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { color } from 'console-log-colors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { getConfig } from './config';
import { logger } from './get-logger';
import { createListCache } from './lib/localsend-cache';
import { createChunkStore, MAX_CHUNK_SIZE } from './lib/localsend-chunk';
import { createCleaner } from './lib/localsend-cleaner';
import { createGuard } from './lib/localsend-guard';
import { resolveInDir, safeRelPath } from './lib/localsend-path';
import { createShareStore } from './lib/localsend-share';
import { cleanupTempFiles, isTempFileName } from './lib/localsend-temp';
import { createWebDavHandler } from './lib/localsend-webdav';
import { getIp } from './lib/utils';
import { createZipChunks, type ZipEntry } from './lib/zip';

/**
 * 前端页面单文件路径（相对本模块）。
 * 构建后页面位于 dist/localsend/index.html；dev（bun）运行时位于 src/localsend/index.html。
 */
const PAGE_REL_PATH = './localsend/index.html';

/** 页面静态资源目录（相对本模块），与 PAGE_REL_PATH 同级 */
const PAGE_DIR = './localsend';

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

/**
 * 同名文件自动追加 _1/_2 后缀（支持子目录，相对路径用 `/` 分隔）
 */
function uniqueName(targetDir: string, relName: string): string {
  const rel = safeRelPath(relName);
  if (!rel) return '';
  const parts = rel.split('/');
  const fileName = parts.pop() as string;
  const subDir = join(targetDir, ...parts);
  const ext = extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  let finalName = fileName;
  let i = 1;
  while (existsSync(join(subDir, finalName))) {
    finalName = `${base}_${i}${ext}`;
    i += 1;
  }
  return parts.length ? `${parts.join('/')}/${finalName}` : finalName;
}

/** 取请求中的相对路径参数（支持通配符路由） */
function relParam(req: Request, key = 'name'): string {
  const value = (req.params as Record<string, unknown>)[key];
  const raw = Array.isArray(value) ? value.join('/') : value;
  return safeRelPath(raw);
}

/**
 * 默认禁止上传的服务端脚本扩展名。
 * 存储目录若位于静态服务的根目录下，上传的可执行脚本可能被 php-cgi 等中间件执行，
 * 相当于对外开放了远程代码执行入口，因此在上传环节直接拦截。
 */
export const DEFAULT_BLOCK_EXTENSIONS = [
  '.php',
  '.php3',
  '.php4',
  '.php5',
  '.php7',
  '.php8',
  '.phtml',
  '.pht',
  '.phar',
  '.cgi',
  '.pl',
  '.py',
  '.rb',
  '.sh',
  '.asp',
  '.aspx',
  '.jsp',
  '.jspx',
];

/** 带状态码的业务错误，便于错误处理中间件输出友好提示 */
class LocalsendError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'LocalsendError';
    this.statusCode = statusCode;
  }
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

  // 自动清理：避免接收端长期运行把磁盘撑满
  if (ls.autoCleanDays || ls.autoCleanMaxSize) {
    const cleaner = createCleaner({
      dir,
      maxAgeDays: ls.autoCleanDays,
      maxTotalSize: ls.autoCleanMaxSize,
      onRemoved: (names) =>
        logger.log(color.yellow('LocalSend 清理 : '.padStart(15, ' ')), color.yellowBright(`已删除 ${names.length} 个过期文件`)),
    });
    // 启动时先清理一次
    setTimeout(() => cleaner.run(), 5000).unref?.();
  }

  const port = config.port || 80;
  const ipUrl = `http://${getIp() || 'localhost'}:${port}`;
  // 配置了令牌时，把令牌带上，方便直接扫码访问
  const keyQuery = ls.token ? `?key=${encodeURIComponent(ls.token)}` : '';
  logger.log(color.green('LocalSend : '.padStart(15, ' ')), color.greenBright('局域网文件传输功能已开启'));
  logger.log(color.green('LocalSend DIR : '.padStart(15, ' ')), color.cyanBright(dir));
  logger.log(color.green('LocalSend URL : '.padStart(15, ' ')), color.cyanBright(`${ipUrl}/localsend${keyQuery}`));
  if (ls.token) logger.log(color.green('LocalSend KEY : '.padStart(15, ' ')), color.yellowBright('已启用访问令牌'));

  // 分享链接：拿到链接的人无需访问令牌即可下载指定文件（需在令牌校验之前注册）
  const shareStore = createShareStore();
  app.get('/localsend/s/:token', async (req: Request, res: Response) => {
    const entry = shareStore.get(String(req.params.token || ''));
    if (!entry) return void res.status(404).json({ code: 1, msg: '分享链接不存在或已过期' });

    const files = entry.names
      .map((rel) => ({ rel, path: resolveInDir(dir, rel) }))
      .filter((f) => f.path && existsSync(f.path) && statSync(f.path).isFile());
    if (!files.length) return void res.status(404).json({ code: 1, msg: '分享的文件已不存在' });

    if (files.length === 1) {
      res.download(files[0].path, basename(files[0].rel), { dotfiles: 'allow' });
      return;
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="localsend-${stamp}.zip"`);
    try {
      for await (const chunk of createZipChunks(
        files.map((f) => ({ name: f.rel, path: f.path, mtime: statSync(f.path).mtime })),
        (p) => createReadStream(p),
      )) {
        res.write(chunk);
      }
      res.end();
    } catch (err) {
      logger.error('[localsend share]', err);
      res.end();
    }
  });

  // 创建分享链接
  app.post('/localsend/api/share', express.json({ limit: '256kb' }), (req: Request, res: Response) => {
    const names = Array.isArray(req.body?.names) ? (req.body.names as unknown[]).map((n) => safeRelPath(n)).filter(Boolean) : [];
    if (!names.length) return void res.status(400).json({ code: 1, msg: '未指定要分享的文件' });
    const ttl = Math.min(Math.max(Number(req.body?.ttl) || 24 * 60 * 60, 60), 7 * 24 * 60 * 60);
    const { token, entry } = shareStore.create(names.slice(0, 100), ttl * 1000);
    res.json({
      code: 0,
      data: {
        token,
        url: `/localsend/s/${token}`,
        expiresAt: entry.expiresAt,
        names: entry.names,
      },
    });
  });

  // 查看 / 撤销分享
  app.get('/localsend/api/share', (_req: Request, res: Response) => {
    res.json({
      code: 0,
      data: shareStore.list().map(({ token, entry }) => ({
        token,
        url: `/localsend/s/${token}`,
        names: entry.names,
        expiresAt: entry.expiresAt,
        hits: entry.hits,
      })),
    });
  });
  app.delete('/localsend/api/share/:token', (req: Request, res: Response) => {
    const ok = shareStore.revoke(String(req.params.token || ''));
    res.json({ code: ok ? 0 : 1, msg: ok ? '' : '分享不存在' });
  });

  // WebDAV 挂载接口：把存储目录暴露为网络盘（资源管理器 / iOS 文件 App 均可挂载）。
  // 必须注册在令牌校验之前：WebDAV 客户端使用 Basic Auth，无法携带 ?key= 查询参数。
  if (ls.webdav !== false) {
    const davHandler = createWebDavHandler({
      dir,
      token: ls.token,
      maxSize,
      maxTotalSize,
      blockExtensions: ls.blockExtensions ?? DEFAULT_BLOCK_EXTENSIONS,
      basePath: '/localsend/dav',
    });
    app.use('/localsend/dav', davHandler);
    logger.log(color.green('LocalSend DAV : '.padStart(15, ' ')), color.cyanBright(`${ipUrl}/localsend/dav`));
  }

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

  // 文件列表（递归返回所有子目录下的文件，name 为相对路径）
  // 使用内存缓存 + fs.watch 增量更新，避免大目录每次请求都全量扫描
  const listCache = createListCache({
    dir,
    ttl: 5 * 60 * 1000,
    filter: (rel) => !isTempFileName(rel.slice(rel.lastIndexOf('/') + 1)),
  });

  // 写操作完成后让列表缓存失效，保证下次请求能看到最新文件
  app.use('/localsend/api', (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      res.on('finish', () => listCache.invalidate());
    }
    next();
  });

  app.get('/localsend/api/list', (req: Request, res: Response) => {
    const sort = String(req.query.sort || 'time');
    const asc = String(req.query.order || 'desc') !== 'desc';
    // 复制一份再排序，避免污染缓存中的顺序
    const list = listCache.list().slice();
    list.sort((a, b) => (sort === 'size' ? (asc ? a.size - b.size : b.size - a.size) : asc ? a.mtime - b.mtime : b.mtime - a.mtime));
    res.json({ code: 0, data: list });
  });

  // 多文件上传
  const blockExts = new Set((ls.blockExtensions ?? DEFAULT_BLOCK_EXTENSIONS).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
  // 记录每个请求产生的临时文件，便于请求结束（含客户端中断）后清理残留
  const tempFiles = new WeakMap<Request, Set<string>>();
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dir),
      filename: (req, _file, cb) => {
        const fileName = randomBytes(16).toString('hex');
        const set = tempFiles.get(req) || new Set<string>();
        set.add(join(dir, fileName));
        tempFiles.set(req, set);
        cb(null, fileName);
      },
    }),
    limits: { fileSize: maxSize, files: 200 },
    // 保留上传文件名的完整相对路径（上传文件夹时可保留目录结构）
    preservePath: true,
    // 显式声明按 latin1 读取 Content-Disposition 参数，保留文件名的原始字节，
    // 再由 decodeUploadName 按 utf-8 / gb18030 解码，避免中文文件名乱码
    defParamCharset: 'latin1',
    // 拦截可执行脚本，避免上传目录与静态服务根目录重叠时形成远程代码执行入口
    fileFilter: (_req, file, cb) => {
      const ext = extname(decodeUploadName(file.originalname)).toLowerCase();
      if (ext && blockExts.has(ext)) {
        cb(new LocalsendError(`出于安全考虑，禁止上传 ${ext} 类型的文件`, 403));
        return;
      }
      cb(null, true);
    },
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
      const temps = tempFiles.get(req);

      // 请求结束（含客户端中断）后清理未转正的临时文件，避免残留占用空间
      res.on('close', () => {
        if (!temps) return;
        for (const tempPath of temps) {
          try {
            rmSync(tempPath, { force: true });
          } catch {
            // 忽略清理失败
          }
        }
        temps.clear();
      });

      for (const f of files) {
        try {
          // 文件名可能是带目录的相对路径（上传文件夹时保留结构）
          const rel = safeRelPath(decodeUploadName(f.originalname)) || `file_${Date.now()}`;
          const name = uniqueName(dir, rel);
          const target = resolveInDir(dir, name);
          if (!target) throw new Error(`非法的文件路径：${rel}`);
          const subDir = dirname(target);
          if (!existsSync(subDir)) mkdirSync(subDir, { recursive: true });
          renameSync(f.path, target);
          temps?.delete(f.path);
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

  // ---------------------------------------------------------------------------
  // 分片上传（断点续传）
  //
  // 大文件弱网传输常中途断开，整包重传代价大。这里把文件切成定长分片逐片上传，
  // 服务端暂存分片；客户端断线重连后查询已上传分片，只补传缺失部分。
  // ---------------------------------------------------------------------------
  const chunkTmpDir = join(dir, '.chunks');
  const chunkStore = createChunkStore({
    dir,
    tmpDir: chunkTmpDir,
    maxSize,
    ttl: 24 * 60 * 60 * 1000,
  });

  /** 分片上传同样禁止服务端脚本类型 */
  const chunkBlockExt = (name: string): boolean => {
    const ext = extname(name).toLowerCase();
    return !!ext && blockExts.has(ext);
  };

  // 初始化上传任务
  app.post('/localsend/api/chunk/init', express.json({ limit: '64kb' }), (req: Request, res: Response) => {
    const name = decodeUploadName(req.body?.name);
    const rel = safeRelPath(name);
    if (!rel) return void res.status(400).json({ code: 1, msg: '非法的文件名' });
    if (chunkBlockExt(rel)) {
      return void res.status(403).json({ code: 1, msg: `出于安全考虑，禁止上传 ${extname(rel).toLowerCase()} 类型的文件` });
    }
    const size = Number(req.body?.size) || 0;
    if (size < 0) return void res.status(400).json({ code: 1, msg: '非法的文件大小' });
    if (maxSize && size > maxSize) {
      return void res.status(413).json({ code: 1, msg: `文件超出大小限制（${(maxSize / 1024 / 1024).toFixed(0)}MB）` });
    }
    const chunkSize = chunkStore.clampChunkSize(req.body?.chunkSize);
    const result = chunkStore.init(rel, size, chunkSize);
    res.json({ code: 0, data: result });
  });

  // 上传单个分片（multipart，字段名 chunk；分片序号放在查询参数里）
  // 使用独立的 multer 实例，分片直接落到暂存目录，不经过存储目录根
  const chunkUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        if (!existsSync(chunkTmpDir)) mkdirSync(chunkTmpDir, { recursive: true });
        cb(null, chunkTmpDir);
      },
      filename: (_req, _file, cb) => cb(null, `incoming-${randomBytes(16).toString('hex')}`),
    }),
    limits: { fileSize: MAX_CHUNK_SIZE, files: 1 },
  });
  app.post('/localsend/api/chunk/upload', guard.limitConcurrent, chunkUpload.single('chunk'), (req: Request, res: Response) => {
    const uploadId = String(req.query.uploadId || '');
    const index = Number(req.query.index);
    const file = req.file;
    if (!uploadId || !file) {
      if (file?.path) rmSync(file.path, { force: true });
      return void res.status(400).json({ code: 1, msg: '缺少 uploadId 或分片数据' });
    }
    const meta = chunkStore.meta(uploadId);
    if (!meta) {
      rmSync(file.path, { force: true });
      return void res.status(404).json({ code: 1, msg: '上传任务不存在或已过期' });
    }
    if (!Number.isInteger(index) || index < 0 || index >= meta.total) {
      rmSync(file.path, { force: true });
      return void res.status(400).json({ code: 1, msg: '非法的分片序号' });
    }
    // 把落下的分片登记到暂存区
    const result = chunkStore.writeChunk(uploadId, index, file.path);
    if (!result) {
      rmSync(file.path, { force: true });
      return void res.status(404).json({ code: 1, msg: '上传任务不存在或已过期' });
    }
    res.json({ code: 0, data: result });
  });

  // 查询上传进度（断点续传的关键）
  app.get('/localsend/api/chunk/status', (req: Request, res: Response) => {
    const uploadId = String(req.query.uploadId || '');
    const result = chunkStore.status(uploadId);
    if (!result) return void res.status(404).json({ code: 1, msg: '上传任务不存在或已过期' });
    res.json({ code: 0, data: result });
  });

  // 合并分片为正式文件
  app.post('/localsend/api/chunk/merge', (req: Request, res: Response) => {
    const uploadId = String(req.query.uploadId || '');
    const meta = chunkStore.meta(uploadId);
    if (!meta) return void res.status(404).json({ code: 1, msg: '上传任务不存在或已过期' });

    // 合并前复核总配额
    if (maxTotalSize) {
      const used = dirSize(dir);
      if (used + meta.size > maxTotalSize) {
        return void res.status(413).json({
          code: 1,
          msg: `存储空间不足：已用 ${(used / 1024 / 1024).toFixed(1)}MB / ${(maxTotalSize / 1024 / 1024).toFixed(1)}MB`,
        });
      }
    }

    const result = chunkStore.merge(uploadId, (name) => {
      const finalName = uniqueName(dir, name);
      const target = resolveInDir(dir, finalName);
      if (!target) return null;
      const subDir = dirname(target);
      if (!existsSync(subDir)) mkdirSync(subDir, { recursive: true });
      return { path: target, name: finalName };
    });
    if (!result) return void res.status(400).json({ code: 1, msg: '分片不完整，无法合并' });
    res.json({ code: 0, data: result });
  });

  // 取消上传并清理分片
  app.delete('/localsend/api/chunk/cancel', (req: Request, res: Response) => {
    const uploadId = String(req.query.uploadId || '');
    const ok = chunkStore.cancel(uploadId);
    res.json({ code: ok ? 0 : 1, msg: ok ? '' : '上传任务不存在' });
  });

  // 下载。dotfiles: 'allow' 以兼容 ~/.static-server 这类隐藏目录作为存储目录
  app.get('/localsend/api/download/*name', (req: Request, res: Response) => {
    const rel = relParam(req);
    if (!rel) return void res.status(400).json({ code: 1, msg: '非法的文件路径' });
    const filePath = resolveInDir(dir, rel);
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      return void res.status(404).json({ code: 1, msg: '文件不存在' });
    }
    res.download(filePath, basename(rel), { dotfiles: 'allow' });
  });

  // 预览（inline 方式返回，浏览器可直读图片/文本等）
  app.get('/localsend/api/preview/*name', (req: Request, res: Response) => {
    const rel = relParam(req);
    if (!rel) return void res.status(400).json({ code: 1, msg: '非法的文件路径' });
    const filePath = resolveInDir(dir, rel);
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      return void res.status(404).json({ code: 1, msg: '文件不存在' });
    }
    res.sendFile(filePath, {
      dotfiles: 'allow',
      headers: { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(rel))}` },
    });
  });

  // 删除
  app.delete('/localsend/api/delete/*name', (req: Request, res: Response) => {
    const rel = relParam(req);
    if (!rel) return void res.status(400).json({ code: 1, msg: '非法的文件路径' });
    const filePath = resolveInDir(dir, rel);
    if (!filePath || !existsSync(filePath)) return void res.status(404).json({ code: 1, msg: '文件不存在' });
    rmSync(filePath);
    res.json({ code: 0 });
  });

  // 批量打包下载：把多个文件流式打成 zip（不落盘、不占额外磁盘）
  app.get('/localsend/api/zip', async (req: Request, res: Response) => {
    const raw = String(req.query.names || '');
    const names = raw
      .split(',')
      .map((n) => safeRelPath(n))
      .filter(Boolean);
    if (!names.length) return void res.status(400).json({ code: 1, msg: '未指定要打包的文件' });

    const entries: ZipEntry[] = [];
    for (const rel of names.slice(0, 500)) {
      const filePath = resolveInDir(dir, rel);
      if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) continue;
      entries.push({ name: rel, path: filePath, mtime: statSync(filePath).mtime });
    }
    if (!entries.length) return void res.status(404).json({ code: 1, msg: '没有可打包的文件' });

    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="localsend-${stamp}.zip"; filename*=UTF-8''localsend-${stamp}.zip`);
    try {
      for await (const chunk of createZipChunks(entries, (p) => createReadStream(p))) {
        res.write(chunk);
      }
      res.end();
    } catch (err) {
      logger.error('[localsend zip]', err);
      res.end();
    }
  });

  // 批量删除
  app.post(
    '/localsend/api/delete-batch',
    // 本模块未启用全局 JSON 解析，这里单独挂载
    express.json({ limit: '1mb' }),
    (req: Request, res: Response) => {
      const names = Array.isArray(req.body?.names) ? req.body.names : [];
      const deleted: string[] = [];
      const failed: string[] = [];
      for (const item of names.slice(0, 500)) {
        const rel = safeRelPath(item);
        const filePath = rel ? resolveInDir(dir, rel) : '';
        if (!filePath || !existsSync(filePath)) {
          failed.push(String(item));
          continue;
        }
        try {
          rmSync(filePath);
          deleted.push(rel);
        } catch (err) {
          logger.error('[localsend 删除]', err);
          failed.push(rel);
        }
      }
      res.json({ code: 0, data: { deleted, failed } });
    },
  );

  // 清理上传残留的临时文件（上传中断时可能留下无扩展名的哈希文件）
  app.post('/localsend/api/cleanup-temp', (_req: Request, res: Response) => {
    const removed = cleanupTempFiles(dir);
    res.json({ code: 0, data: { removed: removed.length } });
  });

  // 统一错误处理：把上传失败、文件超限、类型拦截等转成友好的 JSON 提示
  app.use('/localsend', (err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    let status = 500;
    let msg = err?.message || '请求处理失败';
    if (err instanceof LocalsendError) {
      status = err.statusCode;
    } else if (err instanceof multer.MulterError) {
      status = 400;
      if (err.code === 'LIMIT_FILE_SIZE') msg = `文件超出大小限制（${(maxSize / 1024 / 1024).toFixed(0)}MB）`;
      else if (err.code === 'LIMIT_FILE_COUNT') msg = '一次上传的文件数量超出限制';
      else if (err.code === 'LIMIT_UNEXPECTED_FILE') msg = '非预期的文件字段';
    }
    logger.error('[localsend]', err);
    res.status(status).json({ code: 1, msg });
  });
}
