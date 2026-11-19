/*
 * LocalSend WebDAV
 *
 * 让电脑资源管理器、iOS「文件」App、手机文件管理器等把存储目录挂载成一个网络盘，
 * 生态兼容性比网页界面好得多：可以直接在文件管理器里拖拽上传、双击打开。
 *
 * 支持的方法：
 *  - OPTIONS：声明支持的 DAV 能力
 *  - PROPFIND：列出目录内容（支持 Depth 0 / 1 / infinity）
 *  - GET / HEAD：下载文件（目录返回简易 HTML 列表）
 *  - PUT：上传/覆盖文件（流式写入，不占内存）
 *  - DELETE：删除文件或目录
 *  - MKCOL：新建目录
 *  - COPY / MOVE：复制、移动（部分文件管理器拖拽时会用到）
 */

import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Request, Response } from 'express';
import { isInternalDirName, resolveInDir, safeRelPath } from './path';

export interface WebDavOptions {
  /** 存储目录 */
  dir: string;
  /** 访问令牌。设置后需使用 Basic Auth（用户名为 localsend）。传入函数表示运行时取值 */
  token?: string | (() => string);
  /** 禁止上传的扩展名（含点，如 .php）。传入函数表示运行时取值 */
  blockExtensions?: string[] | (() => string[]);
  /** 存储总容量上限（字节），0 表示不限制。传入函数表示运行时取值 */
  maxTotalSize?: number | (() => number);
  /** 单文件大小上限（字节）。传入函数表示运行时取值 */
  maxSize?: number | (() => number);
  /** 挂载路径前缀，如 /localsend/dav */
  basePath?: string;
}

const DAV_NS = 'DAV:';

/** 常见扩展名的 Content-Type，避免引入额外依赖 */
const MIME_TYPES: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  heic: 'image/heic',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mimeOf(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx < 0) return 'application/octet-stream';
  return MIME_TYPES[name.slice(idx + 1).toLowerCase()] || 'application/octet-stream';
}

/** RFC1123 时间格式（GMT） */
function httpDate(date: Date): string {
  return date.toUTCString();
}

/** XML 转义 */
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 计算目录下所有文件的总大小（字节），与上传接口保持一致 */
export function davDirSize(target: string): number {
  if (!existsSync(target)) return 0;
  let total = 0;
  const walk = (current: string) => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const st = statSync(join(current, name));
        if (st.isDirectory()) walk(join(current, name));
        else if (st.isFile()) total += st.size;
      } catch {
        // 忽略读取失败的条目
      }
    }
  };
  walk(target);
  return total;
}

/**
 * 校验 Basic Auth。
 * 未配置令牌时直接放行；配置后要求用户名为 localsend、密码为令牌。
 */
export function checkDavAuth(req: Request, token: string): boolean {
  if (!token) return true;
  // 也允许通过 ?key= 传递令牌（便于手工调试）
  const queryKey = String(req.query?.key ?? '');
  if (queryKey && queryKey === token) return true;
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    if (index < 0) return false;
    const user = decoded.slice(0, index);
    const pass = decoded.slice(index + 1);
    return user === 'localsend' && pass === token;
  } catch {
    return false;
  }
}

interface DavItem {
  /** 文件名（不含路径） */
  name: string;
  /** 相对存储目录的路径 */
  rel: string;
  isDir: boolean;
  size: number;
  mtime: Date;
}

/** 递归收集目录下的条目 */
function collect(dirAbs: string, rel: string, depth: number, out: DavItem[]): void {
  let names: string[];
  try {
    names = readdirSync(dirAbs).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dirAbs, name);
    let st: Stats;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    const childRel = rel ? `${rel}/${name}` : name;
    const isDir = st.isDirectory();
    // 内部目录（如分片暂存区）不对外暴露
    if (isDir && !rel && isInternalDirName(name)) continue;
    out.push({ name, rel: childRel, isDir, size: isDir ? 0 : st.size, mtime: st.mtime });
    if (isDir && depth > 0) collect(full, childRel, depth - 1, out);
  }
}

/** 生成 PROPFIND 的 207 响应 */
export function buildMultistatus(baseUrl: string, dir: string, relPath: string, depth: number): string {
  const items: DavItem[] = [];

  if (relPath === '') {
    const st = statSync(dir);
    items.push({ name: '/', rel: '', isDir: true, size: 0, mtime: st.mtime });
    if (depth > 0) collect(dir, '', depth, items);
  } else {
    const full = resolveInDir(dir, relPath);
    if (full && existsSync(full)) {
      const st = statSync(full);
      const name = relPath.split('/').pop() || relPath;
      items.push({ name, rel: relPath, isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtime });
      if (st.isDirectory() && depth > 0) collect(full, relPath, depth, items);
    }
  }

  const responses = items
    .map((item) => {
      // 集合（目录）的 href 必须以 / 结尾，这是 Windows 资源管理器挂载的硬性要求
      const suffix = item.rel ? `/${item.rel.split('/').map(encodeURIComponent).join('/')}` : '';
      const href = `${baseUrl}${suffix}${item.isDir ? '/' : ''}`;
      const resourcetype = item.isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>';
      const contentlength = item.isDir ? '' : `<D:getcontentlength>${item.size}</D:getcontentlength>`;
      const contenttype = item.isDir ? '' : `<D:getcontenttype>${mimeOf(item.name)}</D:getcontenttype>`;
      return (
        '<D:response>' +
        `<D:href>${escapeXml(href)}</D:href>` +
        '<D:propstat><D:prop>' +
        `<D:displayname>${escapeXml(item.name)}</D:displayname>` +
        resourcetype +
        contentlength +
        contenttype +
        `<D:getlastmodified>${httpDate(item.mtime)}</D:getlastmodified>` +
        `<D:creationdate>${item.mtime.toISOString()}</D:creationdate>` +
        '<D:supportedlock/>' +
        '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
        '</D:response>'
      );
    })
    .join('');

  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="${DAV_NS}">${responses}</D:multistatus>`;
}

/** 简易目录页（浏览器直接访问时） */
function buildDirHtml(dir: string, relPath: string): string {
  const items: DavItem[] = [];
  collect(dir, relPath, 1, items);
  const rows = items
    .filter((f) => f.rel !== relPath)
    .map((f) => {
      const child = f.rel.slice(relPath ? relPath.length + 1 : 0);
      const href = `${child.split('/').map(encodeURIComponent).join('/')}${f.isDir ? '/' : ''}`;
      return `<li><a href="${href}">${escapeXml(child)}${f.isDir ? '/' : ''}</a> <span>${f.isDir ? '-' : `${f.size} B`}</span></li>`;
    })
    .join('');
  const parent = relPath ? `../` : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>LocalSend</title></head><body><h1>LocalSend</h1><p><a href="${parent}">..</a></p><ul>${rows}</ul></body></html>`;
}

/**
 * 生成 WebDAV 处理函数
 */
export function createWebDavHandler(options: WebDavOptions) {
  const { dir } = options;
  const basePath = (options.basePath || '/localsend/dav').replace(/\/+$/, '');
  /** 运行时读取当前生效的访问令牌 */
  const getToken = (): string => {
    const value = typeof options.token === 'function' ? options.token() : options.token;
    return value || '';
  };
  /** 运行时读取当前生效的单文件大小上限 */
  const getMaxSize = (): number => {
    const value = typeof options.maxSize === 'function' ? options.maxSize() : options.maxSize;
    return value ?? 0;
  };
  /** 运行时读取当前生效的容量上限 */
  const getMaxTotalSize = (): number => {
    const value = typeof options.maxTotalSize === 'function' ? options.maxTotalSize() : options.maxTotalSize;
    return value ?? 0;
  };
  /** 运行时读取当前生效的禁止扩展名 */
  const getBlockExts = (): Set<string> => {
    const list = typeof options.blockExtensions === 'function' ? options.blockExtensions() : options.blockExtensions;
    return new Set((list || []).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
  };

  /** 从请求中解析相对路径（逐段解码，避免 %2F 造成的歧义） */
  const relOf = (req: Request): { rel: string; invalid: boolean } => {
    const raw = String(req.originalUrl || req.url || '/').split('?')[0];
    let path = raw;
    if (path.startsWith(basePath)) path = path.slice(basePath.length);
    const segments = path.split('/').filter(Boolean);
    const decoded = segments
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return '';
        }
      })
      .join('/');
    const rel = safeRelPath(decoded);
    // 原始路径非空但规范化后为空 => 路径非法（如 `..` 穿越）
    const invalid = segments.length > 0 && !rel;
    return { rel, invalid };
  };

  return async function handleWebDav(req: Request, res: Response): Promise<void> {
    if (!checkDavAuth(req, getToken())) {
      res.setHeader('WWW-Authenticate', 'Basic realm="LocalSend"');
      res.status(401).send('需要访问令牌');
      return;
    }

    const method = (req.method || 'GET').toUpperCase();
    const { rel: relPath, invalid } = relOf(req);
    if (invalid) {
      res.status(403).send('非法路径');
      return;
    }

    if (method === 'OPTIONS') {
      res.setHeader('DAV', '1, 2');
      res.setHeader('MS-Author-Via', 'DAV');
      res.setHeader('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE');
      res.status(200).end();
      return;
    }

    if (method === 'PROPFIND') {
      const rawDepth = String(req.headers.depth ?? '1').toLowerCase();
      const depth = rawDepth === '0' ? 0 : rawDepth === 'infinity' ? 32 : 1;
      const xml = buildMultistatus(basePath, dir, relPath, depth);
      res.setHeader('Content-Type', 'application/xml; charset="utf-8"');
      res.setHeader('DAV', '1, 2');
      res.status(207).send(xml);
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      const full = relPath ? resolveInDir(dir, relPath) : dir;
      if (!full || !existsSync(full)) {
        res.status(404).send('文件不存在');
        return;
      }
      const st = statSync(full);
      if (st.isDirectory()) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(buildDirHtml(dir, relPath));
        return;
      }
      res.setHeader('Content-Length', String(st.size));
      res.setHeader('Last-Modified', httpDate(st.mtime));
      res.setHeader('Content-Type', mimeOf(relPath.split('/').pop() || relPath));
      res.setHeader('Accept-Ranges', 'bytes');
      if (method === 'HEAD') {
        res.status(200).end();
        return;
      }
      const stream = createReadStream(full);
      stream.on('error', () => res.end());
      stream.pipe(res);
      return;
    }

    if (method === 'PUT') {
      if (!relPath) {
        res.status(405).send('缺少文件路径');
        return;
      }
      const name = relPath.split('/').pop() || '';
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
      if (ext && getBlockExts().has(ext)) {
        res.status(403).send(`出于安全考虑，禁止上传 ${ext} 类型的文件`);
        return;
      }
      const full = resolveInDir(dir, relPath);
      if (!full) {
        res.status(403).send('非法路径');
        return;
      }
      const maxSize = getMaxSize();
      const maxTotalSize = getMaxTotalSize();
      const declared = Number(req.headers['content-length'] || 0);
      if (maxSize && declared > maxSize) {
        res.status(413).send(`文件超出大小限制（${Math.round(maxSize / 1024 / 1024)}MB）`);
        return;
      }
      if (maxTotalSize) {
        const used = davDirSize(dir);
        if (used + declared > maxTotalSize) {
          res.status(413).send(`存储空间不足：已用 ${(used / 1024 / 1024).toFixed(1)}MB / ${(maxTotalSize / 1024 / 1024).toFixed(1)}MB`);
          return;
        }
      }
      const parent = dirname(full);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

      // 先写临时文件，成功后再转正，避免中断时留下半截文件
      const tempPath = join(parent, `.dav-${randomBytes(12).toString('hex')}.tmp`);
      try {
        await new Promise<void>((resolve, reject) => {
          const stream = createWriteStream(tempPath);
          req.pipe(stream);
          stream.on('finish', () => resolve());
          stream.on('error', reject);
          req.on('aborted', () => reject(new Error('客户端中断上传')));
        });
        renameSync(tempPath, full);
      } catch (err) {
        try {
          rmSync(tempPath, { force: true });
        } catch {
          // 忽略清理失败
        }
        res.status(400).send(`上传失败：${(err as Error)?.message || '未知错误'}`);
        return;
      }
      res.status(201).send('已保存');
      return;
    }

    if (method === 'DELETE') {
      const full = relPath ? resolveInDir(dir, relPath) : '';
      if (!full || !existsSync(full)) {
        res.status(404).send('文件不存在');
        return;
      }
      rmSync(full, { recursive: true, force: true });
      res.status(204).end();
      return;
    }

    if (method === 'MKCOL') {
      const full = resolveInDir(dir, relPath);
      if (!full) {
        res.status(403).send('非法路径');
        return;
      }
      if (existsSync(full)) {
        res.status(405).send('已存在');
        return;
      }
      mkdirSync(full, { recursive: true });
      res.status(201).send('已创建');
      return;
    }

    if (method === 'COPY' || method === 'MOVE') {
      const destHeader = String(req.headers.destination || '');
      if (!destHeader) {
        res.status(400).send('缺少 Destination 头');
        return;
      }
      // Destination 可能是绝对 URL，也可能只是路径
      let destPath = destHeader;
      try {
        destPath = new URL(destHeader, 'http://localhost').pathname;
      } catch {
        // 保持原样
      }
      if (destPath.startsWith(basePath)) destPath = destPath.slice(basePath.length);
      const destRel = safeRelPath(destPath);
      const destFull = destRel ? resolveInDir(dir, destRel) : '';
      if (!destFull) {
        res.status(403).send('非法目标路径');
        return;
      }
      const srcFull = relPath ? resolveInDir(dir, relPath) : '';
      if (!srcFull || !existsSync(srcFull)) {
        res.status(404).send('源文件不存在');
        return;
      }
      const destParent = dirname(destFull);
      if (!existsSync(destParent)) mkdirSync(destParent, { recursive: true });
      try {
        if (statSync(srcFull).isDirectory()) {
          // 目录移动用 rename，复制时逐项复制
          if (method === 'MOVE') {
            renameSync(srcFull, destFull);
          } else {
            copyFileSync(srcFull, destFull);
          }
        } else if (method === 'MOVE') {
          renameSync(srcFull, destFull);
        } else {
          copyFileSync(srcFull, destFull);
        }
      } catch (err) {
        res.status(500).send(`操作失败：${(err as Error)?.message || '未知错误'}`);
        return;
      }
      res.status(method === 'MOVE' ? 201 : 204).end();
      return;
    }

    res.status(405).send('不支持的方法');
  };
}
