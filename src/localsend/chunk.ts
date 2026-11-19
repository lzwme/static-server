/*
 * LocalSend 分片上传（断点续传）
 *
 * 大文件在局域网弱网下常常传到一半就断线，整包重传代价很大。
 * 这里把大文件切成定长分片逐片上传，服务端把分片暂存在临时目录，
 * 客户端重连后通过 uploadId 或文件指纹找回同一个任务，只补传缺失的部分，
 * 全部到齐后再合并成正式文件。
 *
 * 任务元信息（名称/大小/分片数/指纹）会落盘到 `.chunks/<uploadId>.json`：
 *  - 服务重启后仍能按 uploadId 或文件指纹接上（已传分片直接扫目录得出）
 *  - 页面刷新、换标签页也能接上，不必从 0 重传
 *
 * 接口：
 *  - POST   /localsend/api/chunk/init      初始化上传，返回 uploadId 与已上传分片
 *  - POST   /localsend/api/chunk/upload    上传单个分片（multipart，字段名 chunk）
 *  - GET    /localsend/api/chunk/status     查询上传进度
 *  - POST   /localsend/api/chunk/merge      合并分片为正式文件
 *  - DELETE /localsend/api/chunk/cancel    取消并清理分片
 */

import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { logger } from '../get-logger';

/** 元信息文件名后缀 */
const META_SUFFIX = '.json';
/** uploadId 的格式（16 字节随机数的 hex）：防止从客户端传来的 ID 拼出越界路径 */
const UPLOAD_ID_RE = /^[a-f0-9]{32}$/i;

export interface ChunkMeta {
  /** 上传任务 ID */
  uploadId: string;
  /** 目标文件名（相对存储目录） */
  name: string;
  /** 文件总大小（字节） */
  size: number;
  /** 分片大小（字节） */
  chunkSize: number;
  /** 分片总数 */
  total: number;
  /** 已完成的分片索引 */
  received: number[];
  /** 创建时间戳 */
  createdAt: number;
  /** 文件指纹（名称:大小:修改时间），用于客户端重连后找回同一个任务 */
  fileKey?: string;
}

export interface ChunkStoreOptions {
  /** 正式存储目录 */
  dir: string;
  /** 分片暂存目录 */
  tmpDir: string;
  /** 上传任务有效期（毫秒），超时自动清理 */
  ttl?: number;
  /** 单文件大小上限（字节）。传入函数表示运行时取值 */
  maxSize?: number | (() => number);
}

export interface ChunkInitResult {
  uploadId: string;
  name: string;
  size: number;
  chunkSize: number;
  total: number;
  /** 已经上传过的分片索引（断点续传的关键） */
  received: number[];
  /** 是否复用了已有任务（即这次是续传而不是新开） */
  resumed?: boolean;
}

/** 初始化参数：带上其中之一即可续传 */
export interface ChunkInitOptions {
  /** 客户端上次拿到的任务 ID（服务重启后仍可通过落盘元信息找回） */
  uploadId?: string;
  /** 文件指纹（名称:大小:修改时间）：没有 uploadId 时按它找回任务 */
  fileKey?: string;
}

export interface ChunkUploadResult {
  uploadId: string;
  index: number;
  received: number[];
  total: number;
  /** 全部到齐 */
  complete: boolean;
}

export interface ChunkMergeResult {
  /** 最终文件名（可能因同名而追加 _1 后缀） */
  name: string;
  size: number;
}

/** 默认分片大小：8MB，太小会显著增加请求数，太大则断点损失多 */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
/** 分片大小允许范围 */
const MIN_CHUNK_SIZE = 64 * 1024;
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
/** 单个文件最多允许的分片数，防止异常参数导致分片数失控 */
const MAX_CHUNKS = 2048;

/** 分片文件名：`<uploadId>.<index>.part` */
function partName(uploadId: string, index: number): string {
  return `${uploadId}.${index}.part`;
}

/**
 * 分片上传管理器。
 * 任务信息只存内存（重启即失效，分片文件会被清理），避免状态泄漏到磁盘。
 */
export function createChunkStore(options: ChunkStoreOptions) {
  const { tmpDir } = options;
  const ttl = options.ttl ?? 24 * 60 * 60 * 1000;
  /** 运行时读取当前生效的单文件大小上限 */
  const getMaxSize = (): number => {
    const value = typeof options.maxSize === 'function' ? options.maxSize() : options.maxSize;
    return value ?? 0;
  };

  /** uploadId -> 元信息（内存缓存；真正的元信息落盘，重启后可恢复） */
  const metas = new Map<string, ChunkMeta>();

  /** 上次扫描磁盘元信息的时间，避免每次 init 都遍历目录 */
  let lastDiskScan = 0;

  /** 确保暂存目录存在 */
  function ensureTmpDir(): void {
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  }

  /** 元信息落盘路径 */
  function metaPath(uploadId: string): string {
    return join(tmpDir, `${uploadId}.json`);
  }

  /** 把元信息写入磁盘（失败不影响内存中的任务） */
  function persist(meta: ChunkMeta): void {
    ensureTmpDir();
    try {
      writeFileSync(metaPath(meta.uploadId), JSON.stringify(meta), 'utf8');
    } catch {
      // 落盘失败时任务仍可在内存中完成，只是重启后不能续传
    }
  }

  /** 从磁盘读取元信息；非法 ID 或内容损坏返回 null */
  function readMetaFromDisk(uploadId: string): ChunkMeta | null {
    if (!UPLOAD_ID_RE.test(uploadId)) return null;
    const file = metaPath(uploadId);
    if (!existsSync(file)) return null;
    try {
      const meta = JSON.parse(readFileSync(file, 'utf8')) as ChunkMeta;
      if (!meta || meta.uploadId !== uploadId || typeof meta.name !== 'string') return null;
      if (!Number.isFinite(meta.size) || !Number.isFinite(meta.total) || !Number.isFinite(meta.chunkSize)) return null;
      return meta;
    } catch {
      return null;
    }
  }

  /** 取元信息：先内存，再磁盘（服务重启后的懒加载） */
  function loadMeta(uploadId: string): ChunkMeta | null {
    const cached = metas.get(uploadId);
    if (cached) return cached;
    const meta = readMetaFromDisk(uploadId);
    if (meta) metas.set(meta.uploadId, meta);
    return meta;
  }

  /** 按文件指纹找回任务（优先内存，其次磁盘） */
  function findByFileKey(fileKey: string, name: string, size: number): ChunkMeta | null {
    const match = (meta: ChunkMeta): boolean => meta.fileKey === fileKey && meta.name === name && meta.size === size;
    for (const meta of metas.values()) {
      if (match(meta)) return meta;
    }
    // 内存里没有时扫一遍磁盘元信息（数量有上限，代价可控）
    if (!existsSync(tmpDir)) return null;
    let names: string[];
    try {
      names = readdirSync(tmpDir);
    } catch {
      return null;
    }
    for (const fileName of names) {
      if (!fileName.endsWith(META_SUFFIX)) continue;
      const id = fileName.slice(0, -META_SUFFIX.length);
      if (!UPLOAD_ID_RE.test(id)) continue;
      const meta = loadMeta(id);
      if (meta && match(meta)) return meta;
    }
    return null;
  }

  /** 删除暂存目录中某个 uploadId 的全部分片（含落盘元信息） */
  function removeParts(uploadId: string): void {
    if (!existsSync(tmpDir)) return;
    let names: string[];
    try {
      names = readdirSync(tmpDir);
    } catch {
      return;
    }
    for (const name of names) {
      // 分片文件名形如 `<uploadId>.<index>.part`，元信息为 `<uploadId>.json`，
      // 上传过程中的中间文件是 `incoming-<hex>`（由下面的过期清理单独处理）
      if (!name.startsWith(`${uploadId}.`)) continue;
      try {
        rmSync(join(tmpDir, name), { force: true });
      } catch {
        // 忽略清理失败
      }
    }
  }

  /**
   * 扫描磁盘上的元信息，清理过期任务。
   *
   * 主要用于「服务重启后内存里没有任何任务」的场景：
   * 只靠内存遍历会让重启前的分片一直留在磁盘上。
   */
  function cleanupDiskMeta(now: number): number {
    if (!existsSync(tmpDir)) return 0;
    let names: string[];
    try {
      names = readdirSync(tmpDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const fileName of names) {
      // 顺带清掉中断上传留下的中间文件（超过 1 小时）
      if (fileName.startsWith('incoming-')) {
        const full = join(tmpDir, fileName);
        try {
          if (now - statSync(full).mtimeMs > 60 * 60 * 1000) {
            rmSync(full, { force: true });
            removed += 1;
          }
        } catch {
          // 忽略
        }
        continue;
      }
      if (!fileName.endsWith(META_SUFFIX)) continue;
      const id = fileName.slice(0, -META_SUFFIX.length);
      if (!UPLOAD_ID_RE.test(id)) continue;
      const meta = loadMeta(id);
      if (meta && now - meta.createdAt <= ttl) continue;
      removeParts(id);
      metas.delete(id);
      removed += 1;
    }
    return removed;
  }

  /** 清理过期任务及其分片（内存优先，定期顺带扫一次磁盘） */
  function cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, meta] of metas) {
      if (now - meta.createdAt > ttl) {
        removeParts(id);
        metas.delete(id);
        removed++;
      }
    }
    // 磁盘扫描有成本，最多每 5 分钟一次
    if (now - lastDiskScan > 5 * 60 * 1000) {
      lastDiskScan = now;
      removed += cleanupDiskMeta(now);
    }
    return removed;
  }

  /** 定时清理过期任务 */
  const timer = setInterval(cleanupExpired, 10 * 60 * 1000);
  timer.unref?.();

  /** 计算已上传的分片索引（扫描暂存目录） */
  function scanReceived(uploadId: string): number[] {
    if (!existsSync(tmpDir)) return [];
    const received: number[] = [];
    let names: string[];
    try {
      names = readdirSync(tmpDir);
    } catch {
      return [];
    }
    for (const name of names) {
      if (!name.startsWith(`${uploadId}.`)) continue;
      const m = name.match(/^\S+\.(\d+)\.part$/);
      if (m) received.push(Number(m[1]));
    }
    return received.sort((a, b) => a - b);
  }

  return {
    /**
     * 初始化一个上传任务。
     *
     * 带 uploadId 或 fileKey 时会尝试复用已有任务：分片以磁盘实际文件为准，
     * 因此「服务重启」「页面刷新」「换标签页」之后都能从已传的部分接着来。
     */
    init(name: string, size: number, chunkSize?: number, opts: ChunkInitOptions = {}): ChunkInitResult {
      ensureTmpDir();
      cleanupExpired();

      const size2 = chunkSize || DEFAULT_CHUNK_SIZE;
      /** 只有同名同大小的任务才允许复用，避免把内容不同的文件并到一起 */
      const reusable = (meta: ChunkMeta | null): ChunkMeta | null => (meta && meta.name === name && meta.size === size ? meta : null);

      let existing: ChunkMeta | null = null;
      if (opts.uploadId) existing = reusable(loadMeta(String(opts.uploadId)));
      if (!existing && opts.fileKey) existing = reusable(findByFileKey(String(opts.fileKey), name, size));
      if (existing) {
        const received = scanReceived(existing.uploadId);
        // 任务可能因为分片被清空而失去意义：没有任何分片时按新任务处理，
        // 避免客户端拿着一个永远传不完的 uploadId 反复重试
        if (received.length > 0) {
          return {
            uploadId: existing.uploadId,
            name,
            size,
            chunkSize: existing.chunkSize,
            total: existing.total,
            received,
            resumed: true,
          };
        }
        removeParts(existing.uploadId);
        metas.delete(existing.uploadId);
      }

      const total = size > 0 ? Math.ceil(size / size2) : 1;
      if (total > MAX_CHUNKS) {
        throw new Error(`分片数过多（${total}），请增大分片大小`);
      }
      const uploadId = randomBytes(16).toString('hex');
      const meta: ChunkMeta = {
        uploadId,
        name,
        size,
        chunkSize: size2,
        total,
        received: [],
        createdAt: Date.now(),
        fileKey: opts.fileKey ? String(opts.fileKey).slice(0, 300) : undefined,
      };
      metas.set(uploadId, meta);
      // 元信息落盘：服务重启后仍能按 uploadId / 文件指纹接上
      persist(meta);
      return {
        uploadId,
        name,
        size,
        chunkSize: meta.chunkSize,
        total,
        received: [],
        resumed: false,
      };
    },

    /** 记录一个已上传的分片 */
    markReceived(uploadId: string, index: number): ChunkUploadResult | null {
      const meta = loadMeta(uploadId);
      if (!meta) return null;
      if (!meta.received.includes(index)) meta.received.push(index);
      meta.received.sort((a, b) => a - b);
      return {
        uploadId,
        index,
        received: meta.received,
        total: meta.total,
        complete: meta.received.length >= meta.total,
      };
    },

    /** 查询上传进度 */
    status(uploadId: string): (ChunkInitResult & { complete: boolean }) | null {
      const meta = loadMeta(uploadId);
      if (!meta) return null;
      // 以磁盘实际状态为准，避免进程重启后状态与文件不一致
      const received = scanReceived(uploadId);
      return {
        uploadId,
        name: meta.name,
        size: meta.size,
        chunkSize: meta.chunkSize,
        total: meta.total,
        received,
        complete: received.length >= meta.total,
      };
    },

    /**
     * 登记一个已上传的分片。
     * `sourcePath` 为 multer 落下的临时文件路径，会被移动到分片暂存区，
     * 避免把整个分片读进内存。
     */
    writeChunk(uploadId: string, index: number, sourcePath: string): ChunkUploadResult | null {
      const meta = loadMeta(uploadId);
      if (!meta) return null;
      if (index < 0 || index >= meta.total) return null;
      ensureTmpDir();
      const target = join(tmpDir, partName(uploadId, index));
      try {
        renameSync(sourcePath, target);
      } catch {
        // 跨设备时 rename 会失败，退化为 copy
        try {
          copyFileSync(sourcePath, target);
          rmSync(sourcePath, { force: true });
        } catch {
          return null;
        }
      }
      return this.markReceived(uploadId, index);
    },

    /**
     * 合并分片为正式文件（流式、异步）。
     *
     * 由调用方提供 `resolveTarget` 把目标文件名解析为绝对路径（处理同名改名与子目录创建）。
     *
     * 逐片边读边写，不把分片读进内存；也不会像同步循环那样把事件循环占住——
     * 合并 1GB 文件时，同步实现会让 SSE 推送与其它设备的列表请求一起排队数秒。
     * 先写 `<目标名>.<随机>.merging`，校验大小后再转正，中断不会留下半截文件。
     */
    async merge(
      uploadId: string,
      resolveTarget: (name: string) => { path: string; name: string } | null,
    ): Promise<ChunkMergeResult | null> {
      const meta = loadMeta(uploadId);
      if (!meta) return null;
      const received = scanReceived(uploadId);
      if (received.length < meta.total) return null;

      const target = resolveTarget(meta.name);
      if (!target) return null;

      const tempPath = `${target.path}.${randomBytes(8).toString('hex')}.merging`;
      try {
        await new Promise<void>((resolve, reject) => {
          const out = createWriteStream(tempPath, { flags: 'w' });
          let index = 0;
          /** 写入下一片；一片写完再写下一片，保证顺序 */
          const next = () => {
            if (index >= meta.total) {
              out.end();
              return;
            }
            const current = index;
            index += 1;
            const partPath = join(tmpDir, partName(uploadId, current));
            if (!existsSync(partPath)) {
              out.destroy(new Error(`分片 ${current} 缺失`));
              return;
            }
            const input = createReadStream(partPath);
            input.on('error', (err) => out.destroy(err));
            input.on('end', next);
            input.pipe(out, { end: false });
          };
          out.on('finish', () => resolve());
          out.on('error', reject);
          next();
        });

        // 校验落盘大小后再做最终转正
        const stat = statSync(tempPath);
        if (meta.size > 0 && stat.size !== meta.size) {
          throw new Error(`合并后大小不符：${stat.size} != ${meta.size}`);
        }
        try {
          renameSync(tempPath, target.path);
        } catch {
          // 跨设备时 rename 会失败，退化为 copy
          copyFileSync(tempPath, target.path);
          rmSync(tempPath, { force: true });
        }
        // 清理分片与任务
        this.cancel(uploadId);
        return { name: target.name, size: stat.size };
      } catch (err) {
        logger.error('[localsend chunk merge]', err);
        rmSync(tempPath, { force: true });
        return null;
      }
    },

    /** 取消并清理分片 */
    cancel(uploadId: string): boolean {
      const existed = metas.delete(uploadId);
      removeParts(uploadId);
      return existed;
    },

    /** 释放资源（服务关闭时调用） */
    dispose(): void {
      clearInterval(timer);
      for (const id of metas.keys()) this.cancel(id);
    },

    /** 内部：查询元信息 */
    meta(uploadId: string): ChunkMeta | undefined {
      return loadMeta(uploadId) || undefined;
    },

    /** 内部：单文件大小上限 */
    get maxSize() {
      return getMaxSize();
    },
    /** 内部：分片大小钳制 */
    clampChunkSize(size?: number): number {
      const n = Number(size) || DEFAULT_CHUNK_SIZE;
      return Math.min(Math.max(n, MIN_CHUNK_SIZE), MAX_CHUNK_SIZE);
    },

    /** 停止定时清理（进程退出或测试收尾时调用） */
    stop(): void {
      clearInterval(timer);
      metas.clear();
    },
    /** 内部：分片总数上限 */
    maxChunks: MAX_CHUNKS,
  };
}
