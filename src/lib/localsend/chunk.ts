/*
 * LocalSend 分片上传（断点续传）
 *
 * 大文件在局域网弱网下常常传到一半就断线，整包重传代价很大。
 * 这里把大文件切成定长分片逐片上传，服务端把分片暂存在临时目录，
 * 客户端重连后通过 uploadId 查询已完成的分片，只补传缺失的部分，
 * 全部到齐后再合并成正式文件。
 *
 * 接口：
 *  - POST   /localsend/api/chunk/init      初始化上传，返回 uploadId 与已上传分片
 *  - POST   /localsend/api/chunk/upload    上传单个分片（multipart，字段名 chunk）
 *  - GET    /localsend/api/chunk/status     查询上传进度
 *  - POST   /localsend/api/chunk/merge      合并分片为正式文件
 *  - DELETE /localsend/api/chunk/cancel    取消并清理分片
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../get-logger';

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

  /** uploadId -> 元信息 */
  const metas = new Map<string, ChunkMeta>();

  /** 确保暂存目录存在 */
  function ensureTmpDir(): void {
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  }

  /** 删除暂存目录中某个 uploadId 的全部分片 */
  function removeParts(uploadId: string): void {
    if (!existsSync(tmpDir)) return;
    let names: string[];
    try {
      names = readdirSync(tmpDir);
    } catch {
      return;
    }
    for (const name of names) {
      // 分片文件名形如 `<uploadId>.<index>.part`，另外也清掉上传过程中的中间文件
      if (!name.startsWith(`${uploadId}.`)) continue;
      try {
        rmSync(join(tmpDir, name), { force: true });
      } catch {
        // 忽略清理失败
      }
    }
  }

  /** 清理过期任务及其分片 */
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
    /** 初始化一个上传任务 */
    init(name: string, size: number, chunkSize?: number): ChunkInitResult {
      ensureTmpDir();
      cleanupExpired();

      const size2 = chunkSize || DEFAULT_CHUNK_SIZE;
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
      };
      metas.set(uploadId, meta);
      return {
        uploadId,
        name,
        size,
        chunkSize: meta.chunkSize,
        total,
        received: [],
      };
    },

    /** 记录一个已上传的分片 */
    markReceived(uploadId: string, index: number): ChunkUploadResult | null {
      const meta = metas.get(uploadId);
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
      const meta = metas.get(uploadId);
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
      const meta = metas.get(uploadId);
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
     * 合并分片为正式文件。
     * 由调用方提供 `resolveTarget` 把目标文件名解析为绝对路径（处理同名改名与子目录创建）。
     */
    merge(uploadId: string, resolveTarget: (name: string) => { path: string; name: string } | null): ChunkMergeResult | null {
      const meta = metas.get(uploadId);
      if (!meta) return null;
      const received = scanReceived(uploadId);
      if (received.length < meta.total) return null;

      const target = resolveTarget(meta.name);
      if (!target) return null;

      // 合并到临时文件，成功后再转正，避免中断留下半截文件
      const tempPath = `${target.path}.${randomBytes(8).toString('hex')}.merging`;
      let written = 0;
      try {
        // 同步追加写入：确保返回前数据已完全落盘，便于后续的大小校验
        rmSync(tempPath, { force: true });
        for (let i = 0; i < meta.total; i++) {
          const partPath = join(tmpDir, partName(uploadId, i));
          if (!existsSync(partPath)) throw new Error(`分片 ${i} 缺失`);
          const buf = readFileSync(partPath);
          appendFileSync(tempPath, buf);
          written += buf.length;
        }
      } catch (err) {
        logger.error('[localsend chunk merge]', err);
        rmSync(tempPath, { force: true });
        return null;
      }

      // 校验落盘大小后再做最终转正
      try {
        const stat = statSync(tempPath);
        if (meta.size > 0 && stat.size !== meta.size) {
          rmSync(tempPath, { force: true });
          return null;
        }
        // 用 copy + rm 代替 rename，避免跨盘符（暂存目录与存储目录可能在不同卷）导致失败
        try {
          renameSync(tempPath, target.path);
        } catch {
          // 跨设备时 rename 会失败，退化为 copy
          copyFileSync(tempPath, target.path);
          rmSync(tempPath, { force: true });
        }
      } catch (err) {
        logger.error('[localsend chunk merge]', err);
        rmSync(tempPath, { force: true });
        return null;
      }

      // 清理分片与任务
      this.cancel(uploadId);
      return { name: target.name, size: written };
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
      return metas.get(uploadId);
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
