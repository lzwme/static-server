/*
 * LocalSend 局域网文件传输服务端模块
 * 路由：
 *  - GET    /localsend                   页面
 *  - GET    /localsend/api/list          文件列表（分页 + 搜索 + 筛选 + 排序）
 *  - GET    /localsend/api/facets        筛选选项（目录 / 扩展名及各自条目数）
 *  - POST   /localsend/api/upload        多文件上传（multipart，字段名 files）
 *  - GET    /localsend/api/download/:name  下载（attachment）
 *  - GET    /localsend/api/preview/:name   预览（inline）
 *  - DELETE /localsend/api/delete/:name    删除
 *  - POST   /localsend/api/rename        重命名 / 移动单个文件
 *  - POST   /localsend/api/move          批量移动到指定目录
 *  - POST   /localsend/api/rename-batch  按规则批量重命名
 */

import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { color } from 'console-log-colors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { getConfig, type LocalSendConfig } from '../config';
import { logger } from '../get-logger';
import { getIpCandidates, isLoopbackAddress, isPrivateAddress } from '../lib/utils';
import { canManage, canWrite, createAuth } from './auth';
import { createListCache } from './cache';
import { createChunkStore, MAX_CHUNK_SIZE } from './chunk';
import { createCleaner } from './cleaner';
import { createGuard } from './guard';
import { batchRename, moveFiles, parseRenameRule, renameFile, uniqueName } from './manage';
import { buildPasteName, contentHash, parsePaste, parseStrategy, timeStampTag } from './paste';
import { resolveInDir, safeRelPath } from './path';
import { collectDirs, collectExts, filterEntries, paginate, parseListQuery, ROOT_DIR, sortEntries } from './query';
import { SECRET_ITERATIONS } from './secret';
import { createSettingsStore, normalizeSetting, SETTING_DEFS, type SettingKey } from './settings';
import { createShareStore, shareInlineMime, shareInlineType } from './share';
import { cleanupTempFiles, isTempFileName } from './temp';
import { createTrash } from './trash';
import { createWebDavHandler } from './webdav';
import { createZipChunks, type ZipEntry } from './zip';

/**
 * 前端页面单文件路径（相对本模块所在目录）。
 *
 * 本模块位于 src/localsend（dev）或 dist/localsend（prod），
 * 页面资源位于同级的 client 目录（src/localsend/client / dist/localsend/client），
 * 两处结构一致，因此用同一条相对路径即可，无需区分开发态与运行态。
 */
const PAGE_REL_PATH = './client/index.html';

/** 页面静态资源目录（相对本模块），与 PAGE_REL_PATH 同级 */
const PAGE_DIR = './client';

/**
 * 前端构建产物目录（相对本模块所在目录）。
 *
 * 产物（tailwind 生成的 style.css、vendor 第三方库）刻意不放进源码目录，
 * 避免与源码混在一起造成误解；它们集中存放在仓库根的 assets/ 下，
 * 由构建生成、不纳入版本管理。
 */
const ASSETS_REL = 'assets/localsend';

/**
 * 探测前端构建产物目录。
 *
 * 产物位置随运行方式而变，因此不写死单一路径，而是从运行目录逐级向上找
 * 第一个包含 style.css 的 assets 目录：
 *  - 运行态（__dirname 为 dist/localsend）：dist 内自带 assets，发布包开箱即用
 *  - 开发态（__dirname 为 src/localsend）：产物在仓库根 assets/，需上溯两级
 *
 * 逐级探测的好处是：产物目录无论放在运行目录、其上级还是仓库根，
 * 都能被找到；同时不会误取到更外层的无关 assets 目录。
 *
 * 找不到时返回 null，由调用方决定降级处理（给出提示而非直接崩溃）。
 *
 * @param baseDir 运行目录，默认取当前模块所在目录
 */
export function resolveAssetsDir(baseDir: string = __dirname): string | null {
  let dir = resolve(baseDir);
  for (let depth = 0; depth < 5; depth++) {
    const candidate = join(dir, ASSETS_REL);
    if (existsSync(join(candidate, 'style.css'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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

export interface LocalsendHandle {
  /** 停止目录监听与后台定时任务（进程退出、测试收尾时调用） */
  stop: () => void;
}

export async function initLocalsend(app: Express): Promise<LocalsendHandle> {
  const config = await getConfig();
  const raw = config.localsend;
  if (!raw) return { stop: () => {} };

  const ls = typeof raw === 'boolean' ? { enabled: raw } : raw;
  if (!ls.enabled) return { stop: () => {} };

  const dir = ls.dir || '';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // ---------------------------------------------------------------------------
  // 运行时设置
  //
  // 配置文件的值是「出厂设置」，管理员在网页端改过的值单独存一份，
  // 启动时合并进来并立即生效，无需重启服务。
  // ---------------------------------------------------------------------------
  const settings = createSettingsStore();
  settings.load();
  const merged = settings.apply(ls as unknown as Record<string, unknown>) as unknown as LocalSendConfig;

  /** 当前生效的配置，管理员修改后直接改这里，各处读取时随之更新 */
  const live = {
    token: String(merged.token || ''),
    password: String(merged.password || ''),
    visitorPassword: String(merged.visitorPassword || ''),
    sessionTtl: Number(merged.sessionTtl) || 24 * 60 * 60 * 1000,
    // 未设置时默认 1GB；显式设为 0 表示不限制
    maxSize: merged.maxSize === undefined ? 1024 * 1024 * 1024 : Number(merged.maxSize),
    maxTotalSize: Number(merged.maxTotalSize) || 0,
    maxConcurrent: Number(merged.maxConcurrent ?? 3),
    rateLimit: {
      windowMs: Number(merged.rateLimit?.windowMs) || 60_000,
      max: Number(merged.rateLimit?.max ?? 120),
    },
    blockExtensions: [...(merged.blockExtensions || DEFAULT_BLOCK_EXTENSIONS)],
    trashDays: Number(merged.trashDays ?? 1),
    autoCleanDays: Number(merged.autoCleanDays) || 0,
    autoCleanMaxSize: Number(merged.autoCleanMaxSize) || 0,
  };

  /** 当前禁止上传/保存的扩展名集合（含点、小写），运行时修改立即生效 */
  const getBlockExts = (): Set<string> => new Set(live.blockExtensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));

  // 回收站：删除的文件先移入此处，可在一段时间内还原
  const trash = createTrash({
    dir,
    ttl: () => live.trashDays * 24 * 60 * 60 * 1000,
  });

  // 自动清理：避免接收端长期运行把磁盘撑满
  // 始终创建，以便管理员在网页端随时开启或调整清理策略
  const cleaner = createCleaner({
    dir,
    maxAgeDays: () => live.autoCleanDays,
    maxTotalSize: () => live.autoCleanMaxSize,
    onRemoved: (names) =>
      logger.log(color.yellow('LocalSend 清理 : '.padStart(15, ' ')), color.yellowBright(`已删除 ${names.length} 个过期文件`)),
  });
  // 启动时先清理一次
  setTimeout(() => cleaner.run(), 5000).unref?.();

  const port = config.port || 80;
  /**
   * 启动时列出全部候选地址。
   *
   * 以前只打印一个地址，且取到的是「排序后的第一个」——多网卡机器
   * （WSL / Docker / VPN / 虚拟机）经常拿到一个手机根本连不上的地址，
   * 用户扫码后只会看到「无法访问此网站」，却不知道是网卡选错了。
   */
  const ipCandidates = getIpCandidates();
  const ipUrl = `http://${ipCandidates[0]?.address || 'localhost'}:${port}`;
  logger.log(color.green('LocalSend : '.padStart(15, ' ')), color.greenBright('局域网文件传输功能已开启'));
  logger.log(color.green('LocalSend DIR : '.padStart(15, ' ')), color.cyanBright(dir));
  logger.log(color.green('LocalSend URL : '.padStart(15, ' ')), color.cyanBright(`${ipUrl}/localsend`));
  if (ipCandidates.length > 1) {
    const others = ipCandidates
      .slice(1)
      .map((item) => `${item.address}(${item.iface})`)
      .join(' ');
    logger.log(color.green('LocalSend 其它地址 :'.padStart(15, ' ')), color.gray(`${others}（页面可切换后重新生成二维码）`));
  }
  if (live.token)
    logger.log(color.green('LocalSend KEY : '.padStart(15, ' ')), color.yellowBright('已启用访问令牌（访问时需输入令牌换取会话）'));

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
      const file = files[0];
      // 文本与图片直接在浏览器里打开，扫一眼就能看到内容，不必先下载
      // 需要强制下载时加 ?dl=1
      const inline = req.query.dl === undefined ? shareInlineType(file.rel) : false;
      if (inline) {
        res.setHeader('Content-Type', shareInlineMime(file.rel));
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(basename(file.rel))}`);
        createReadStream(file.path).pipe(res);
        return;
      }
      res.download(file.path, basename(file.rel), { dotfiles: 'allow' });
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

  // ---------------------------------------------------------------------------
  // 访问控制
  //
  // 注册顺序很关键：
  //  1. 身份与摘要库要先建好：WebDAV 与令牌校验都要用到它
  //  2. 分享下载页与 WebDAV 必须放在令牌校验之前
  //     —— 分享链接本就是免登录的，WebDAV 走 Basic Auth 带不了自定义请求头
  //  3. 认证接口（取盐值、口令登录、令牌换会话）也要放在令牌校验之前，
  //     否则用户还没拿到会话就无从登录
  //  4. 令牌校验之后才是全部业务接口，任何接口都不能绕过
  //  5. 身份分级再叠在令牌之上，用来区分危险操作的权限
  // ---------------------------------------------------------------------------
  // 身份与权限
  //
  // token 是站点级大门锁，这里是进门后的身份分级：
  // 管理员能删除与整理，访客只能上传下载。
  // 没有配置访客口令时，未登录的人也能上传下载（删除与整理仍需管理员口令）。
  // 没有配置任何口令时保持开放模式，行为与以前完全一致。
  const auth = createAuth({
    password: live.password,
    visitorPassword: live.visitorPassword,
    token: live.token,
    sessionTtl: live.sessionTtl,
  });
  if (auth.open) {
    logger.log(color.yellow('LocalSend 权限 :'.padStart(15, ' ')), color.yellow('未设置口令，任何人都可以删除与整理文件'));
  } else if (live.visitorPassword) {
    logger.log(
      color.green('LocalSend 权限 :'.padStart(15, ' ')),
      color.cyanBright('已启用身份分级（危险操作需要管理员口令，上传下载需要访客口令）'),
    );
  } else {
    logger.log(
      color.green('LocalSend 权限 :'.padStart(15, ' ')),
      color.cyanBright('已启用身份分级（危险操作需要管理员口令，上传下载无需口令）'),
    );
  }
  if (live.visitorPassword && !auth.hasAdmin) {
    logger.log(color.yellow('LocalSend 权限 :'.padStart(15, ' ')), color.yellow('只配置了访客口令，删除与整理将无法执行'));
  }

  /** 从请求中取会话令牌 */
  function sessionTokenOf(req: Request): string {
    return String(req.get('X-Localsend-Session') || req.query.session || '');
  }

  // 访问防护：令牌 / 频率限制 / 并发限制
  const guard = createGuard({
    hasToken: () => auth.hasToken,
    // 请求头里的令牌摘要：脚本等非浏览器客户端可以直接用
    verifyKey: (digest) => auth.verifyToken(digest),
    verifySession: (token) => !!auth.get(token),
    maxConcurrent: () => live.maxConcurrent,
    rateLimit: () => live.rateLimit,
  });

  // WebDAV 挂载接口：把存储目录暴露为网络盘（资源管理器 / iOS 文件 App 均可挂载）。
  if (ls.webdav !== false) {
    const davHandler = createWebDavHandler({
      dir,
      hasToken: () => auth.hasToken,
      // WebDAV 客户端只能用 Basic Auth 传明文，服务端用盐值现场算摘要再比对
      verifyToken: (presented) => auth.verifyTokenValue(presented),
      verifyPlain: (value) => auth.plainRole(value),
      isOpen: () => auth.open,
      hasVisitor: () => auth.hasVisitor,
      maxSize: () => live.maxSize,
      maxTotalSize: () => live.maxTotalSize,
      blockExtensions: () => live.blockExtensions,
      basePath: '/localsend/dav',
    });
    app.use('/localsend/dav', davHandler);
    logger.log(color.green('LocalSend DAV : '.padStart(15, ' ')), color.cyanBright(`${ipUrl}/localsend/dav`));
  }

  // ---------------------------------------------------------------------------
  // 接口频率限制
  //
  // 放在认证接口之前：盐值/登录/换令牌这三个接口免鉴权，
  // 而摘要比对本身要跑 PBKDF2，是最耗 CPU 的路径。
  // 不限流的话，一次死循环式的重复提交就能把服务端的 CPU 打满。
  // ---------------------------------------------------------------------------
  app.use('/localsend/api', guard.rateLimit);

  // ---------------------------------------------------------------------------
  // 认证接口（免鉴权）：客户端先取盐值算出摘要，再换取会话令牌
  // ---------------------------------------------------------------------------

  // 各密钥的公开盐值：客户端据此派生出摘要，明文口令与原始令牌都不出浏览器
  app.get('/localsend/api/auth/salt', (_req: Request, res: Response) => {
    res.json({ code: 0, data: { iterations: SECRET_ITERATIONS, secrets: auth.secrets() } });
  });

  // 口令登录：提交口令摘要，服务端比对后签发会话
  app.post('/localsend/api/auth/login', express.json({ limit: '4kb' }), (req: Request, res: Response) => {
    const digests = (req.body?.digests || {}) as { password?: string; visitorPassword?: string };
    const session = auth.login(digests);
    if (!session) {
      // 不区分口令不存在还是口令错误，避免暴露配置细节
      return void res.status(401).json({ code: 1, msg: '口令不正确' });
    }
    res.json({ code: 0, data: { token: session.token, role: session.role, expiresAt: session.expiresAt } });
  });

  // 访问令牌换会话：令牌只在这一步参与，之后请求里只有会话令牌
  app.post('/localsend/api/auth/token', express.json({ limit: '4kb' }), (req: Request, res: Response) => {
    const session = auth.loginByToken(String(req.body?.digest || ''));
    if (!session) return void res.status(401).json({ code: 1, msg: '访问令牌不正确' });
    res.json({ code: 0, data: { token: session.token, role: session.role, expiresAt: session.expiresAt } });
  });

  /**
   * 候选访问地址（免鉴权）。
   *
   * 页面用这些地址生成二维码。手机扫码打不开的第一大原因，是主机有多张网卡
   * （WSL / Docker / VPN / 虚拟机）而服务端取错了那一个——这里把全部候选
   * 连同「本次请求实际连上的地址」一起返回，由页面决定展示与切换。
   *
   * 不含任何用户数据，因此放在令牌校验之前：页面还没输入访问令牌时
   * 也要能把二维码画出来。
   */
  app.get('/localsend/api/network', (req: Request, res: Response) => {
    // 客户端实际连上的本机地址，对它一定可达
    const connected = String(req.socket?.localAddress || '');
    const addresses = getIpCandidates();
    let suggested = '';
    if (connected && !isLoopbackAddress(connected) && isPrivateAddress(connected)) {
      suggested = connected;
    }
    if (!suggested) suggested = addresses[0]?.address || '';
    res.json({
      code: 0,
      data: {
        addresses,
        suggested,
        connected,
        loopback: !connected || isLoopbackAddress(connected),
      },
    });
  });

  // 访问令牌校验（配置了 token 才生效）：页面与静态资源放行，接口需要会话或令牌摘要
  app.use('/localsend', guard.requireAuth);

  // 身份中间件：把当前角色挂到 res.locals.role
  app.use('/localsend/api', (req: Request, res: Response, next: NextFunction) => {
    res.locals.role = auth.roleOf(sessionTokenOf(req));
    next();
  });

  /** 需要管理员权限：删除、整理、撤销分享、清理回收站等危险操作 */
  function requireAdmin(_req: Request, res: Response, next: NextFunction) {
    if (canManage(res.locals.role)) return next();
    // needAuth 供前端识别「需要登录」而不是其它 403（如禁止上传的类型）
    res.status(403).json({ code: 1, msg: '该操作需要管理员权限，请先登录', needAuth: true });
  }

  /** 需要写入权限：上传、粘贴、创建分享等 */
  function requireWrite(_req: Request, res: Response, next: NextFunction) {
    // 未配置访客口令时，任何人都能上传下载；配置了则必须先登录
    if (canWrite(res.locals.role, !!live.visitorPassword)) return next();
    res.status(403).json({ code: 1, msg: '上传需要访客口令，请先登录', needAuth: true });
  }

  // 注销 / 查询当前身份
  app.post('/localsend/api/logout', (req: Request, res: Response) => {
    const token = sessionTokenOf(req);
    auth.logout(token);
    res.json({ code: 0, data: { role: auth.roleOf('') } });
  });

  app.get('/localsend/api/session', (req: Request, res: Response) => {
    const session = auth.get(sessionTokenOf(req));
    res.json({
      code: 0,
      data: {
        role: res.locals.role,
        open: auth.open,
        hasAdmin: auth.hasAdmin,
        hasVisitor: !!live.visitorPassword,
        // 是否配置了访问令牌：前端据此决定要不要提示输入令牌
        hasToken: auth.hasToken,
        // 当前请求带的会话是否有效。
        // 不能靠角色推断：用访问令牌换来的会话角色也是 guest，
        // 靠角色判断会把刚换到的会话误当成失效会话清掉。
        sessionValid: !!session,
        expiresAt: session?.expiresAt ?? 0,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // 设置管理
  //
  // 管理员在网页端即可修改口令、令牌与各项限制，改完立即生效，无需重启服务。
  // 配置文件的值是「出厂设置」，运行时改动单独存一份，
  // 若之后用户又改了配置文件里的同一项，则以配置文件为准。
  // ---------------------------------------------------------------------------

  /** 敏感值脱敏：只露出开头几位，避免接口泄露完整口令 */
  function maskValue(text: string): string {
    if (!text) return '';
    if (text.length <= 4) return '****';
    return `${text.slice(0, 4)}****`;
  }

  /**
   * 从配置文件里的原始值算出最终生效的值（含默认值归一化）。
   * 恢复默认设置时回到这里，而不是直接用未归一化的原始值。
   */
  function configValueOf(key: SettingKey): unknown {
    const raw = (ls as unknown as Record<string, unknown>)[key];
    switch (key) {
      case 'token':
        return String(raw || '');
      case 'password':
        return String(raw || '');
      case 'visitorPassword':
        return String(raw || '');
      case 'sessionTtl':
        return Number(raw) || 24 * 60 * 60 * 1000;
      case 'maxSize':
        return raw === undefined ? 1024 * 1024 * 1024 : Number(raw);
      case 'maxTotalSize':
        return Number(raw) || 0;
      case 'maxConcurrent':
        return Number(raw ?? 3);
      case 'rateLimit':
        return {
          windowMs: Number((raw as { windowMs?: number })?.windowMs) || 60_000,
          max: Number((raw as { max?: number })?.max ?? 120),
        };
      case 'blockExtensions':
        return [...((raw as string[]) || DEFAULT_BLOCK_EXTENSIONS)];
      case 'trashDays':
        return Number(raw ?? 1);
      case 'autoCleanDays':
        return Number(raw) || 0;
      case 'autoCleanMaxSize':
        return Number(raw) || 0;
      default:
        return raw;
    }
  }

  /** 组装当前生效的设置项 */
  function buildSettingsPayload() {
    const items = (Object.keys(SETTING_DEFS) as SettingKey[]).map((key) => {
      const def = SETTING_DEFS[key];
      const value = live[key];
      const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
      const item: Record<string, unknown> = {
        key,
        label: def.label,
        kind: def.kind,
        unit: def.unit || '',
        desc: def.desc,
        secret: !!def.secret,
        source: settings.source(key),
        set: !empty,
      };
      if (def.secret) item.masked = maskValue(String(value || ''));
      else item.value = value;
      return item;
    });
    return {
      items,
      // 这两项与路由注册、存储路径有关，改动需要重启服务
      restartRequired: [
        { key: 'dir', label: '文件存储目录', value: dir },
        { key: 'webdav', label: 'WebDAV 网络盘', value: ls.webdav !== false },
      ],
      file: settings.file,
    };
  }

  /** 把一项设置应用到运行时；口令类改动同时让旧会话失效（当前会话保留） */
  function applySetting(key: SettingKey, value: unknown, req: Request) {
    switch (key) {
      case 'token':
        live.token = String(value || '');
        break;
      case 'password':
        live.password = String(value || '');
        break;
      case 'visitorPassword':
        live.visitorPassword = String(value || '');
        break;
      case 'sessionTtl':
        live.sessionTtl = Number(value) || live.sessionTtl;
        break;
      case 'maxSize':
        live.maxSize = Number(value) || 0;
        break;
      case 'maxTotalSize':
        live.maxTotalSize = Number(value) || 0;
        break;
      case 'maxConcurrent':
        live.maxConcurrent = Number(value) || 0;
        break;
      case 'rateLimit':
        live.rateLimit = (value || { windowMs: 60_000, max: 120 }) as { windowMs: number; max: number };
        break;
      case 'blockExtensions':
        live.blockExtensions = [...((value as string[]) || [])];
        break;
      case 'trashDays':
        live.trashDays = Number(value) || 0;
        break;
      case 'autoCleanDays':
        live.autoCleanDays = Number(value) || 0;
        break;
      case 'autoCleanMaxSize':
        live.autoCleanMaxSize = Number(value) || 0;
        break;
      default:
        break;
    }
    // 口令变更后，此前的会话全部失效，当前会话保留（避免改完口令自己被踢下线）
    if (key === 'password' || key === 'visitorPassword' || key === 'sessionTtl') {
      auth.update({ password: live.password, visitorPassword: live.visitorPassword, sessionTtl: live.sessionTtl }, sessionTokenOf(req));
    }
    // 令牌变更：只作废「用令牌换来的会话」，口令登录的会话继续有效
    if (key === 'token') {
      auth.update({ token: live.token }, sessionTokenOf(req));
    }
  }

  // 查看设置（仅管理员）
  app.get('/localsend/api/settings', requireAdmin, (_req: Request, res: Response) => {
    res.json({ code: 0, data: buildSettingsPayload() });
  });

  // 修改设置（仅管理员）
  app.post('/localsend/api/settings', requireAdmin, express.json({ limit: '64kb' }), (req: Request, res: Response) => {
    const changes = req.body?.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      return void res.status(400).json({ code: 1, msg: '缺少要修改的配置项' });
    }
    const keys = Object.keys(changes) as SettingKey[];
    for (const key of keys) {
      if (!(key in SETTING_DEFS)) return void res.status(400).json({ code: 1, msg: `未知的配置项：${key}` });
    }
    // 改口令需要再次验证当前管理员口令，防止会话被劫持后改掉口令
    // 客户端提交的是当前口令的摘要，明文口令同样不上网
    if ((keys.includes('password') || keys.includes('visitorPassword')) && !auth.verifyAdmin(req.body?.currentPasswordDigest)) {
      return void res.status(403).json({ code: 1, msg: '当前管理员口令不正确', needAuth: true });
    }
    // 先全部校验通过再逐项生效，避免出现「改了一半」
    const normalized: { key: SettingKey; value: unknown }[] = [];
    for (const key of keys) {
      const { value, error } = normalizeSetting(key, changes[key]);
      if (error) return void res.status(400).json({ code: 1, msg: error });
      normalized.push({ key, value });
    }
    for (const item of normalized) {
      // 记录配置文件里的原值作为基准：之后若用户改了配置文件，以配置文件为准
      settings.set(item.key, item.value, (ls as unknown as Record<string, unknown>)[item.key]);
      applySetting(item.key, item.value, req);
    }
    logger.log(color.green('LocalSend 设置 :'.padStart(15, ' ')), color.cyanBright(`已更新：${normalized.map((i) => i.key).join('、')}`));
    res.json({ code: 0, data: { applied: normalized.map((i) => i.key), ...buildSettingsPayload() } });
  });

  // 恢复某项设置为配置文件里的值
  app.delete('/localsend/api/settings/:key', requireAdmin, (req: Request, res: Response) => {
    const key = String(req.params.key || '') as SettingKey;
    if (!(key in SETTING_DEFS)) return void res.status(400).json({ code: 1, msg: '未知的配置项' });
    settings.clear(key);
    // 回到配置文件里的值（同样要走默认值归一化，否则未设置的项会变成 0）
    applySetting(key, configValueOf(key), req);
    logger.log(color.green('LocalSend 设置 :'.padStart(15, ' ')), color.cyanBright(`已恢复默认：${key}`));
    res.json({ code: 0, data: { applied: [key], ...buildSettingsPayload() } });
  });

  // ---------------------------------------------------------------------------
  // 剪贴板内容落盘
  //
  // 分享只能分享「已经存在于存储目录里的文件」，
  // 这里把纯文本与截图直接写成普通文件，
  // 让「粘贴即分享」成为可能，同时继承列表、回收站、WebDAV 等全部能力。
  // ---------------------------------------------------------------------------
  app.post('/localsend/api/paste', requireWrite, express.json({ limit: '16mb' }), (req: Request, res: Response) => {
    const parsed = parsePaste(req.body);
    if (parsed.error) return void res.status(400).json({ code: 1, msg: parsed.error });

    // 单个文件的体积限制，与上传保持一致
    if (live.maxSize && parsed.buffer.length > live.maxSize) {
      return void res.status(413).json({ code: 1, msg: `内容超出大小限制（${(live.maxSize / 1024 / 1024).toFixed(0)}MB）` });
    }
    // 总容量预检
    if (live.maxTotalSize) {
      const used = dirSize(dir);
      if (used + parsed.buffer.length > live.maxTotalSize) {
        return void res.status(413).json({
          code: 1,
          msg: `存储空间不足：已用 ${(used / 1024 / 1024).toFixed(1)}MB / ${(live.maxTotalSize / 1024 / 1024).toFixed(1)}MB`,
        });
      }
    }

    const hash = contentHash(parsed.buffer);
    const strategy = parseStrategy(req.body?.strategy);
    const fileName = buildPasteName(
      { kind: parsed.kind, hash, stamp: timeStampTag(), name: String(req.body?.name ?? ''), strategy },
      parsed.ext,
    );
    // 与上传保持一致：粘贴同样不允许落盘可执行脚本（自定义文件名也不能绕过）
    const pasteExt = extname(fileName).toLowerCase();
    if (pasteExt && getBlockExts().has(pasteExt)) {
      return void res.status(403).json({ code: 1, msg: `出于安全考虑，禁止保存 ${pasteExt} 类型的文件` });
    }
    // 目标目录：只允许落在存储目录内
    const rawDir = String(req.body?.dir ?? '').trim();
    const subDir = rawDir ? safeRelPath(rawDir) : '';
    if (rawDir && !subDir) return void res.status(400).json({ code: 1, msg: '非法的目标目录' });
    const rel = subDir ? `${subDir}/${fileName}` : fileName;
    const target = resolveInDir(dir, rel);
    if (!target) return void res.status(400).json({ code: 1, msg: '非法的文件路径' });

    // 同名且内容一致时直接复用，避免粘贴同一段内容产生一堆重复文件
    if (existsSync(target) && statSync(target).isFile()) {
      try {
        if (contentHash(readFileSync(target)) === hash) {
          return void res.json({ code: 0, data: { name: rel, size: parsed.buffer.length, hash, reused: true } });
        }
      } catch {
        // 读取失败时按新文件处理
      }
    }

    // 同名但内容不同：追加 _1 后缀
    const finalRel = uniqueName(dir, rel);
    const finalAbs = resolveInDir(dir, finalRel);
    if (!finalAbs) return void res.status(400).json({ code: 1, msg: '非法的文件路径' });
    try {
      if (!existsSync(dirname(finalAbs))) mkdirSync(dirname(finalAbs), { recursive: true });
      writeFileSync(finalAbs, parsed.buffer);
    } catch (err) {
      logger.error('[localsend paste]', err);
      return void res.status(500).json({ code: 1, msg: '内容保存失败' });
    }
    res.json({ code: 0, data: { name: finalRel, size: parsed.buffer.length, hash, reused: false } });
  });

  // 创建分享链接
  app.post('/localsend/api/share', requireWrite, express.json({ limit: '256kb' }), (req: Request, res: Response) => {
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
  app.delete('/localsend/api/share/:token', requireAdmin, (req: Request, res: Response) => {
    const ok = shareStore.revoke(String(req.params.token || ''));
    res.json({ code: ok ? 0 : 1, msg: ok ? '' : '分享不存在' });
  });

  // 页面：初始化时读入独立 html 单文件
  const pageHtml = readFileSync(resolve(__dirname, PAGE_REL_PATH), 'utf8');
  app.get('/localsend', (_req: Request, res: Response) => {
    res.type('html').send(pageHtml);
  });

  // 页面静态资源（图标、页面脚本等）：与页面同目录，供离线局域网使用
  // 使用 ETag 协商缓存：升级后样式与页面版本始终一致，避免浏览器拿到旧的 CSS
  app.use(
    '/localsend',
    express.static(resolve(__dirname, PAGE_DIR), {
      index: false,
      maxAge: 0,
      etag: true,
    }),
  );

  // 前端构建产物（tailwind 样式、vendor 第三方库）：与源码分树存放，
  // 放在页面目录之后兜底，避免覆盖页面目录里的同名文件
  const assetsDir = resolveAssetsDir();
  if (assetsDir) {
    app.use(
      '/localsend',
      express.static(assetsDir, {
        index: false,
        maxAge: 0,
        etag: true,
      }),
    );
  } else {
    logger.warn(`[localsend] 未找到前端构建产物，请先执行 ${color.yellow('npm run build:assets')} 生成后再访问页面`);
  }

  // 文件列表（递归返回所有子目录下的文件，name 为相对路径）
  // 使用内存缓存 + fs.watch 增量更新，避免大目录每次请求都全量扫描
  // ------------------------------------------------------------------
  // 文件变化推送（SSE）
  //
  // 目录监听在缓存层已经就绪，这里把变更事件推给页面，
  // 让手机端能第一时间知道「收到了新文件」，不必手动刷新列表。
  // ------------------------------------------------------------------
  /** 已连接的 SSE 客户端 */
  const eventClients = new Set<Response>();

  /** 向所有客户端推送文件变更 */
  function broadcastChange(names: string[]): void {
    if (!eventClients.size || !names.length) return;
    const payload = JSON.stringify({ names });
    for (const client of eventClients) {
      try {
        client.write(`event: changed\ndata: ${payload}\n\n`);
      } catch {
        eventClients.delete(client);
      }
    }
  }

  const listCache = createListCache({
    dir,
    ttl: 5 * 60 * 1000,
    filter: (rel) => !isTempFileName(rel.slice(rel.lastIndexOf('/') + 1)),
    onChange: broadcastChange,
  });
  // 启动即开始监听，保证没有列表请求时也能感知新文件
  listCache.startWatch();

  // SSE 长连接：页面订阅后实时接收文件变更
  app.get('/localsend/api/events', (req: Request, res: Response) => {
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // 建议客户端 3 秒重连，并先发一个 ready 事件确认连接建立
    res.write('retry: 3000\n\n');
    res.write('event: ready\ndata: {}\n\n');
    eventClients.add(res);
    req.on('close', () => {
      eventClients.delete(res);
    });
  });

  // 写操作完成后让列表缓存失效，保证下次请求能看到最新文件
  app.use('/localsend/api', (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      res.on('finish', () => listCache.invalidate());
    }
    next();
  });

  // 文件列表（分页 + 搜索 + 筛选 + 排序）
  //
  // 文件多的时候一次性返回全量会让手机端卡顿，搜索也只能在前端做。
  // 这里把关键词、目录、扩展名、时间窗等条件全部下推到服务端，
  // 只返回当前页，同时给出筛选后的总数，供分页控件展示。
  app.get('/localsend/api/list', (req: Request, res: Response) => {
    const query = parseListQuery(req.query as Record<string, unknown>);
    const all = listCache.list();
    const filtered = filterEntries(all, query);
    const sorted = sortEntries(filtered, query.sort, query.asc);
    const result = paginate(sorted, query.page, query.pageSize);
    // allTotal 是不带任何筛选条件的文件总数，前端用来显示「筛选 N / 共 M」
    res.json({ code: 0, data: { ...result, allTotal: all.length } });
  });

  // 筛选选项（目录 / 扩展名）
  //
  // 服务端分页之后前端拿不到全量文件，无法再自己枚举目录，
  // 这里单独提供一个接口把可选项和各自的条目数返回给页面。
  app.get('/localsend/api/facets', (_req: Request, res: Response) => {
    const all = listCache.list();
    const { dirs, rootCount } = collectDirs(all);
    res.json({ code: 0, data: { dirs, rootCount, exts: collectExts(all), total: all.length } });
  });

  // 多文件上传
  // 记录每个请求产生的临时文件，便于请求结束（含客户端中断）后清理残留
  const tempFiles = new WeakMap<Request, Set<string>>();
  // 单文件硬性上限：运行时把 maxSize 设为 0（不限制）时仍保留一道防线，避免磁盘被单个请求撑满
  const HARD_UPLOAD_LIMIT = 1024 * 1024 * 1024 * 1024;
  // 每次请求都按当前生效的 maxSize 创建 multer 实例，确保运行时修改立即生效
  const createUpload = () =>
    multer({
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
      limits: { fileSize: live.maxSize > 0 ? live.maxSize : HARD_UPLOAD_LIMIT, files: 200 },
      // 保留上传文件名的完整相对路径（上传文件夹时可保留目录结构）
      preservePath: true,
      // 显式声明按 latin1 读取 Content-Disposition 参数，保留文件名的原始字节，
      // 再由 decodeUploadName 按 utf-8 / gb18030 解码，避免中文文件名乱码
      defParamCharset: 'latin1',
      // 拦截可执行脚本，避免上传目录与静态服务根目录重叠时形成远程代码执行入口
      fileFilter: (_req, file, cb) => {
        const ext = extname(decodeUploadName(file.originalname)).toLowerCase();
        if (ext && getBlockExts().has(ext)) {
          cb(new LocalsendError(`出于安全考虑，禁止上传 ${ext} 类型的文件`, 403));
          return;
        }
        cb(null, true);
      },
    });
  app.post(
    '/localsend/api/upload',
    // 写操作需要访客以上权限（只读访问不允许上传）
    requireWrite,
    // 单 IP 并发上传数限制
    guard.limitConcurrent,
    // 总容量预检：目录已用容量与本次请求体大小共同判断，超出配额直接拒绝
    (req: Request, res: Response, next) => {
      if (!live.maxTotalSize) return next();
      const used = dirSize(dir);
      if (used >= live.maxTotalSize) {
        res.status(413).json({
          code: 1,
          msg: `存储空间已满：${(used / 1024 / 1024).toFixed(1)}MB / ${(live.maxTotalSize / 1024 / 1024).toFixed(1)}MB`,
        });
        return;
      }
      // multipart 请求体的 Content-Length 包含少量协议开销，作为保守估计
      const need = Number(req.get('Content-Length') || 0);
      if (need > 0 && used + need > live.maxTotalSize) {
        res.status(413).json({
          code: 1,
          msg: `剩余容量不足：已用 ${(used / 1024 / 1024).toFixed(1)}MB，本次需要约 ${(need / 1024 / 1024).toFixed(1)}MB`,
        });
        return;
      }
      next();
    },
    // 按请求创建，使 maxSize 的运行时修改立即生效
    (req: Request, res: Response, next: NextFunction) => createUpload().array('files')(req, res, next),
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
      if (live.maxTotalSize && dirSize(dir) > live.maxTotalSize) {
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
    maxSize: () => live.maxSize,
    ttl: 24 * 60 * 60 * 1000,
  });

  /** 分片上传同样禁止服务端脚本类型 */
  const chunkBlockExt = (name: string): boolean => {
    const ext = extname(name).toLowerCase();
    return !!ext && getBlockExts().has(ext);
  };

  // 初始化上传任务
  app.post('/localsend/api/chunk/init', requireWrite, express.json({ limit: '64kb' }), (req: Request, res: Response) => {
    const name = decodeUploadName(req.body?.name);
    const rel = safeRelPath(name);
    if (!rel) return void res.status(400).json({ code: 1, msg: '非法的文件名' });
    if (chunkBlockExt(rel)) {
      return void res.status(403).json({ code: 1, msg: `出于安全考虑，禁止上传 ${extname(rel).toLowerCase()} 类型的文件` });
    }
    const size = Number(req.body?.size) || 0;
    if (size < 0) return void res.status(400).json({ code: 1, msg: '非法的文件大小' });
    if (live.maxSize && size > live.maxSize) {
      return void res.status(413).json({ code: 1, msg: `文件超出大小限制（${(live.maxSize / 1024 / 1024).toFixed(0)}MB）` });
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
  app.post(
    '/localsend/api/chunk/upload',
    requireWrite,
    guard.limitConcurrent,
    chunkUpload.single('chunk'),
    (req: Request, res: Response) => {
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
    },
  );

  // 查询上传进度（断点续传的关键）
  app.get('/localsend/api/chunk/status', (req: Request, res: Response) => {
    const uploadId = String(req.query.uploadId || '');
    const result = chunkStore.status(uploadId);
    if (!result) return void res.status(404).json({ code: 1, msg: '上传任务不存在或已过期' });
    res.json({ code: 0, data: result });
  });

  // 合并分片为正式文件
  app.post('/localsend/api/chunk/merge', requireWrite, (req: Request, res: Response) => {
    const uploadId = String(req.query.uploadId || '');
    const meta = chunkStore.meta(uploadId);
    if (!meta) return void res.status(404).json({ code: 1, msg: '上传任务不存在或已过期' });

    // 合并前复核总配额
    if (live.maxTotalSize) {
      const used = dirSize(dir);
      if (used + meta.size > live.maxTotalSize) {
        return void res.status(413).json({
          code: 1,
          msg: `存储空间不足：已用 ${(used / 1024 / 1024).toFixed(1)}MB / ${(live.maxTotalSize / 1024 / 1024).toFixed(1)}MB`,
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
  app.delete('/localsend/api/chunk/cancel', requireWrite, (req: Request, res: Response) => {
    const uploadId = String(req.query.uploadId || '');
    const ok = chunkStore.cancel(uploadId);
    res.json({ code: ok ? 0 : 1, msg: ok ? '' : '上传任务不存在' });
  });

  // ---------------------------------------------------------------------------
  // 传输测速
  //
  // 局域网速度受路由器、频段和负载影响很大，用户需要一个直观的方式
  // 判断当前链路质量：下载方向直接推数据，上传方向接收后立即丢弃。
  // ---------------------------------------------------------------------------

  // 下载测速：GET /localsend/api/speed?size=10（单位 MB，1~100，默认 10）
  app.get('/localsend/api/speed', (req: Request, res: Response) => {
    const mb = Math.min(Math.max(Number(req.query.size) || 10, 1), 100);
    const size = mb * 1024 * 1024;
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
    });
    // 固定内容的数据块，循环输出即可，无需生成随机数
    const block = Buffer.alloc(256 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < size) {
        const n = Math.min(block.length, size - sent);
        sent += n;
        if (!res.write(n === block.length ? block : block.subarray(0, n))) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });

  // 上传测速：POST /localsend/api/speed（接收请求体并丢弃，不落盘）
  app.post('/localsend/api/speed', (req: Request, res: Response) => {
    const start = Date.now();
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    req.on('end', () => {
      res.json({ code: 0, data: { bytes, ms: Date.now() - start } });
    });
    req.on('error', () => {
      if (!res.headersSent) res.status(400).json({ code: 1, msg: '测速数据接收失败' });
    });
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

  // 删除（移入回收站，可还原）
  app.delete('/localsend/api/delete/*name', requireAdmin, (req: Request, res: Response) => {
    const rel = relParam(req);
    if (!rel) return void res.status(400).json({ code: 1, msg: '非法的文件路径' });
    const filePath = resolveInDir(dir, rel);
    if (!filePath || !existsSync(filePath)) return void res.status(404).json({ code: 1, msg: '文件不存在' });
    const entry = trash.add(rel);
    if (!entry) {
      // 移入回收站失败时退化为直接删除
      try {
        rmSync(filePath);
      } catch {
        return void res.status(500).json({ code: 1, msg: '删除失败' });
      }
      return void res.json({ code: 0, data: { trashed: false } });
    }
    res.json({ code: 0, data: { trashed: true, id: entry.id, name: entry.name } });
  });

  // 回收站：列出条目
  app.get('/localsend/api/trash', (_req: Request, res: Response) => {
    res.json({ code: 0, data: trash.list() });
  });

  // 回收站：还原
  app.post('/localsend/api/trash/:id/restore', requireAdmin, (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const restored = trash.restore(id);
    if (!restored) return void res.status(404).json({ code: 1, msg: '回收站条目不存在或已过期' });
    res.json({ code: 0, data: { name: restored } });
  });

  // 回收站：彻底删除
  app.delete('/localsend/api/trash/:id', requireAdmin, (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    const ok = trash.remove(id);
    res.json({ code: ok ? 0 : 1, msg: ok ? '' : '回收站条目不存在' });
  });

  // 回收站：清空
  app.delete('/localsend/api/trash', requireAdmin, (_req: Request, res: Response) => {
    const count = trash.empty();
    res.json({ code: 0, data: { removed: count } });
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

  // ---------------------------------------------------------------------------
  // 文件整理（纯文件操作）
  //
  // 只改真实目录结构，不引入任何元数据存储，
  // 因此整理完的文件在回收站、分享链接、WebDAV 里都能直接看到。
  // ---------------------------------------------------------------------------

  // 重命名 / 移动单个文件（to 带目录即为移动）
  app.post('/localsend/api/rename', requireAdmin, express.json({ limit: '64kb' }), (req: Request, res: Response) => {
    const from = String(req.body?.from ?? '');
    const to = String(req.body?.to ?? '');
    const result = renameFile(dir, from, to);
    if (result.code !== 0) return void res.status(400).json({ code: 1, msg: result.msg });
    res.json({ code: 0, data: { from: result.from, to: result.to } });
  });

  // 批量移动到指定目录
  app.post('/localsend/api/move', requireAdmin, express.json({ limit: '1mb' }), (req: Request, res: Response) => {
    const names = Array.isArray(req.body?.names) ? req.body.names : [];
    if (!names.length) return void res.status(400).json({ code: 1, msg: '未指定要移动的文件' });
    const rawDir = String(req.body?.dir ?? '').trim();
    // 目标目录非法时直接拒绝，避免把文件挪到存储目录之外
    if (rawDir && rawDir !== ROOT_DIR && !safeRelPath(rawDir)) {
      return void res.status(400).json({ code: 1, msg: '非法的目标目录' });
    }
    const result = moveFiles(dir, names, rawDir);
    res.json({ code: 0, data: result });
  });

  // 按规则批量重命名
  app.post('/localsend/api/rename-batch', requireAdmin, express.json({ limit: '1mb' }), (req: Request, res: Response) => {
    const names = Array.isArray(req.body?.names) ? req.body.names : [];
    if (!names.length) return void res.status(400).json({ code: 1, msg: '未指定要重命名的文件' });
    const rule = parseRenameRule(req.body?.rule);
    const result = batchRename(dir, names, rule);
    res.json({ code: 0, data: result });
  });

  // 批量删除
  app.post(
    '/localsend/api/delete-batch',
    // 批量删除属于危险操作，需要管理员权限
    requireAdmin,
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
          // 优先移入回收站，失败时退化为直接删除
          if (!trash.add(rel)) rmSync(filePath);
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
  app.post('/localsend/api/cleanup-temp', requireAdmin, (_req: Request, res: Response) => {
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
      if (err.code === 'LIMIT_FILE_SIZE') msg = `文件超出大小限制（${(live.maxSize / 1024 / 1024).toFixed(0)}MB）`;
      else if (err.code === 'LIMIT_FILE_COUNT') msg = '一次上传的文件数量超出限制';
      else if (err.code === 'LIMIT_UNEXPECTED_FILE') msg = '非预期的文件字段';
    }
    logger.error('[localsend]', err);
    res.status(status).json({ code: 1, msg });
  });

  return {
    stop: () => {
      // 断开所有事件推送连接
      for (const client of eventClients) {
        try {
          client.end();
        } catch {
          // 忽略关闭失败
        }
      }
      eventClients.clear();
      // 停止目录监听与后台定时任务，否则进程无法退出
      listCache.stop();
      trash.stop();
      shareStore.stop();
      chunkStore.stop();
    },
  };
}
