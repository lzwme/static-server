/*
 * LocalSend 回收站
 *
 * 删除文件时先移入回收站，而不是直接抹掉，
 * 这样误删后还能在一定时间内还原。
 *
 * 回收站目录位于存储目录下的 `.trash` 内部目录，
 * 不出现在文件列表、WebDAV 目录与自动清理范围内。
 * 超过保留期限的条目会被自动清理。
 */

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TrashOptions {
  /** 存储目录 */
  dir: string;
  /** 回收站保留时长（毫秒），默认 24 小时。传入函数表示运行时取值 */
  ttl?: number | (() => number);
  /** 清理检查间隔（毫秒），默认 1 小时 */
  intervalMs?: number;
}

export interface TrashEntry {
  /** 回收条目 ID */
  id: string;
  /** 原始相对路径（含子目录） */
  name: string;
  /** 文件大小（字节） */
  size: number;
  /** 删除时间戳 */
  deletedAt: number;
  /** 保留到期时间戳 */
  expiresAt: number;
}

export interface Trash {
  /** 移入回收站，返回条目信息 */
  add(relPath: string): TrashEntry | null;
  /** 还原到原位置，返回还原后的相对路径 */
  restore(id: string): string | null;
  /** 彻底删除 */
  remove(id: string): boolean;
  /** 清空回收站，返回删除数量 */
  empty(): number;
  /** 列出回收站条目（按删除时间倒序） */
  list(): TrashEntry[];
  /** 立即执行一次过期清理 */
  cleanup(): number;
  /** 停止定时清理 */
  stop(): void;
}

/** 回收站目录名 */
export const TRASH_DIR_NAME = '.trash';

/** 条目文件名前缀 */
const ENTRY_PREFIX = 'item-';

export function createTrash(options: TrashOptions): Trash {
  const { dir } = options;
  /** 运行时读取当前生效的保留时长 */
  const getTtl = (): number => {
    const value = typeof options.ttl === 'function' ? options.ttl() : options.ttl;
    return value ?? 24 * 60 * 60 * 1000;
  };
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  const trashDir = join(dir, TRASH_DIR_NAME);

  /** 确保回收站目录存在 */
  function ensureDir(): void {
    if (!existsSync(trashDir)) mkdirSync(trashDir, { recursive: true });
  }

  /** 条目在回收站中的实际路径 */
  function entryPath(id: string): string {
    return join(trashDir, ENTRY_PREFIX + id);
  }

  /** 读取条目的元信息 */
  function readMeta(id: string): TrashEntry | null {
    const path = entryPath(id);
    const metaPath = `${path}.json`;
    if (!existsSync(metaPath)) return null;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (!meta?.name) return null;
      return meta as TrashEntry;
    } catch {
      return null;
    }
  }

  /** 写入条目的元信息 */
  function writeMeta(entry: TrashEntry): void {
    writeFileSync(`${entryPath(entry.id)}.json`, JSON.stringify(entry), 'utf8');
  }

  /** 删除条目的元信息文件 */
  function removeMeta(id: string): void {
    try {
      rmSync(`${entryPath(id)}.json`, { force: true });
    } catch {
      // 忽略清理失败
    }
  }

  /** 彻底移除一个条目 */
  function purge(id: string): void {
    try {
      rmSync(entryPath(id), { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
    removeMeta(id);
  }

  /** 清理过期条目 */
  function cleanup(): number {
    if (!existsSync(trashDir)) return 0;
    let names: string[];
    try {
      names = readdirSync(trashDir);
    } catch {
      return 0;
    }
    const now = Date.now();
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith(ENTRY_PREFIX) || !name.endsWith('.json')) continue;
      const id = name.slice(ENTRY_PREFIX.length, -'.json'.length);
      const meta = readMeta(id);
      if (!meta) {
        // 元信息丢失，清掉残留
        purge(id);
        removed++;
        continue;
      }
      if (meta.expiresAt <= now) {
        purge(id);
        removed++;
      }
    }
    return removed;
  }

  const timer = setInterval(() => {
    try {
      cleanup();
    } catch {
      // 清理失败不影响服务
    }
  }, intervalMs);
  timer.unref?.();

  return {
    add(relPath: string): TrashEntry | null {
      ensureDir();
      const src = join(dir, ...relPath.split('/'));
      if (!existsSync(src)) return null;
      let size = 0;
      try {
        const st = statSync(src);
        size = st.isFile() ? st.size : 0;
      } catch {
        size = 0;
      }
      const id = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
      const now = Date.now();
      const entry: TrashEntry = {
        id,
        name: relPath,
        size,
        deletedAt: now,
        expiresAt: now + getTtl(),
      };
      try {
        // 移动到回收站；若跨设备失败则退化为复制
        try {
          renameSync(src, entryPath(id));
        } catch {
          copyFileSync(src, entryPath(id));
          rmSync(src, { recursive: true, force: true });
        }
      } catch {
        return null;
      }
      writeMeta(entry);
      return entry;
    },

    restore(id: string): string | null {
      const meta = readMeta(id);
      if (!meta) return null;
      const src = entryPath(id);
      if (!existsSync(src)) {
        removeMeta(id);
        return null;
      }
      const dest = join(dir, ...meta.name.split('/'));
      try {
        const parent = dest.slice(0, dest.length - meta.name.split('/').pop()!.length);
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
        // 原位置已被占用时自动改名，避免覆盖。只改文件名部分，扩展名按最后一个点切分（无点则整体作为文件名）
        const parts = meta.name.split('/');
        const fileName = parts.pop() || '';
        const dot = fileName.lastIndexOf('.');
        const ext = dot > 0 ? fileName.slice(dot) : '';
        const base = dot > 0 ? fileName.slice(0, dot) : fileName;
        let finalDest = dest;
        let i = 1;
        while (existsSync(finalDest)) {
          const renamed = ext ? `${base}_${i}${ext}` : `${fileName}_${i}`;
          finalDest = join(dir, ...parts, renamed);
          i += 1;
        }
        try {
          renameSync(src, finalDest);
        } catch {
          copyFileSync(src, finalDest);
          rmSync(src, { recursive: true, force: true });
        }
        removeMeta(id);
        // 返回还原后的相对路径
        const rel = finalDest
          .slice(dir.length)
          .replace(/^[\\/]+/, '')
          .split(/[\\/]+/)
          .join('/');
        return rel;
      } catch {
        return null;
      }
    },

    remove(id: string): boolean {
      const meta = readMeta(id);
      if (!meta) return false;
      purge(id);
      return true;
    },

    empty(): number {
      if (!existsSync(trashDir)) return 0;
      let names: string[];
      try {
        names = readdirSync(trashDir);
      } catch {
        return 0;
      }
      let count = 0;
      for (const name of names) {
        // 每个条目由「数据文件 + .json 元信息文件」两个文件组成，
        // 这里只按元信息文件计数，避免重复统计
        if (!name.startsWith(ENTRY_PREFIX) || !name.endsWith('.json')) continue;
        const id = name.slice(ENTRY_PREFIX.length, -'.json'.length);
        purge(id);
        count += 1;
      }
      return count;
    },

    list(): TrashEntry[] {
      if (!existsSync(trashDir)) return [];
      let names: string[];
      try {
        names = readdirSync(trashDir);
      } catch {
        return [];
      }
      const entries: TrashEntry[] = [];
      for (const name of names) {
        if (!name.startsWith(ENTRY_PREFIX) || !name.endsWith('.json')) continue;
        const id = name.slice(ENTRY_PREFIX.length, -'.json'.length);
        const meta = readMeta(id);
        if (meta) entries.push(meta);
      }
      entries.sort((a, b) => b.deletedAt - a.deletedAt);
      return entries;
    },

    cleanup,

    stop(): void {
      clearInterval(timer);
    },
  };
}
