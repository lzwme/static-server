/*
 * LocalSend 文件列表缓存
 *
 * 存储目录里可能有成千上万个文件，每次请求都递归扫描一遍 statSync，
 * 在大目录上会明显拖慢响应。这里加一层内存缓存：
 *  - 首次访问时全量扫描
 *  - 通过 fs.watch 监听目录变化，增量更新缓存
 *  - watch 不可用或事件丢失时，用 TTL 定期全量校准兜底
 */
import { existsSync, type FSWatcher, readdirSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { type FileEntry, isInternalDirName, listFiles } from './localsend-path';

export interface ListCacheOptions {
  /** 存储目录 */
  dir: string;
  /** 缓存有效期（毫秒）。超过后强制全量重扫，默认 5 分钟 */
  ttl?: number;
  /** 是否启用 fs.watch 增量更新，默认开启 */
  watchEnabled?: boolean;
  /** 过滤函数：返回 false 的条目不进入缓存 */
  filter?: (relPath: string) => boolean;
  /** 变更回调：文件新增或内容变化时触发，参数为发生变化的相对路径 */
  onChange?: (names: string[]) => void;
}

export interface ListCache {
  /** 获取文件列表（命中缓存则直接返回） */
  list(): FileEntry[];
  /** 强制刷新缓存 */
  refresh(): FileEntry[];
  /** 使缓存失效，下次访问时重新扫描 */
  invalidate(): void;
  /** 启动目录监听（用于主动感知变更，不依赖列表请求） */
  startWatch(): void;
  /** 缓存统计信息 */
  stats(): { entries: number; hits: number; misses: number; watching: boolean; lastScan: number };
  /** 停止监听 */
  stop(): void;
}

export function createListCache(options: ListCacheOptions): ListCache {
  const { dir } = options;
  const ttl = options.ttl ?? 5 * 60 * 1000;
  const watchEnabled = options.watchEnabled !== false;

  /** 缓存的文件列表 */
  let entries: FileEntry[] = [];
  /** 是否已经扫描过 */
  let loaded = false;
  /** 上次全量扫描时间 */
  let lastScan = 0;
  /** 命中/未命中计数 */
  let hits = 0;
  let misses = 0;

  /** 待处理的增量变更 */
  const pending = new Map<string, { type: 'add' | 'change' | 'remove'; at: number }>();
  /** 合并变更的定时器 */
  let flushTimer: NodeJS.Timeout | null = null;

  /** 全量扫描并写入缓存 */
  function scan(): FileEntry[] {
    const filter = options.filter;
    const list = listFiles(dir, filter);
    entries = list;
    loaded = true;
    lastScan = Date.now();
    return entries;
  }

  /** 取相对路径对应的条目索引 */
  function findIndex(rel: string): number {
    return entries.findIndex((e) => e.name === rel);
  }

  /** 读取单个文件的元信息 */
  function statOf(rel: string): FileEntry | null {
    const parts = rel.split('/');
    const name = parts.pop() as string;
    try {
      const st = statSync(join(dir, ...parts, name));
      if (!st.isFile()) return null;
      return {
        name: rel,
        size: st.size,
        mtime: st.mtimeMs,
        ext: name.slice(name.lastIndexOf('.') + 1).toLowerCase(),
        isDir: false,
      };
    } catch {
      return null;
    }
  }

  /** 应用一次增量变更 */
  function applyChange(rel: string, type: 'add' | 'change' | 'remove'): void {
    const filter = options.filter;
    if (type === 'remove') {
      const idx = findIndex(rel);
      if (idx >= 0) entries.splice(idx, 1);
      return;
    }
    // 内部目录（如分片暂存区）不进入缓存
    if (rel.split('/').some((p) => isInternalDirName(p))) return;
    if (filter && !filter(rel)) return;
    const meta = statOf(rel);
    if (!meta) {
      // 文件可能已被删除
      const idx = findIndex(rel);
      if (idx >= 0) entries.splice(idx, 1);
      return;
    }
    const idx = findIndex(rel);
    if (idx >= 0) entries[idx] = meta;
    else entries.push(meta);
  }

  /** 合并并应用待处理的变更 */
  function flush(): void {
    flushTimer = null;
    if (!pending.size) return;
    const changed: string[] = [];
    for (const [rel, info] of pending) {
      applyChange(rel, info.type);
      // 删除不作为「收到新文件」通知
      if (info.type !== 'remove') changed.push(rel);
    }
    pending.clear();
    if (changed.length) options.onChange?.(changed);
  }

  /** 记录一次变更（同一文件短时间内多次变更只保留最后一次） */
  function queue(rel: string, type: 'add' | 'change' | 'remove'): void {
    pending.set(rel, { type, at: Date.now() });
    if (flushTimer) return;
    // 合并 100ms 内的连续变更，避免大目录频繁变动时反复重排
    flushTimer = setTimeout(flush, 100);
    flushTimer.unref?.();
  }

  /** 监听器集合（需要监听子目录） */
  const watchers: FSWatcher[] = [];

  /** 为一个目录建立监听 */
  function watchDir(target: string): void {
    if (!existsSync(target)) return;
    try {
      const w = watch(target, { persistent: false }, (eventType, filename) => {
        if (!filename) return;
        const name = String(filename);
        // 内部目录变化不处理
        if (isInternalDirName(name)) return;
        const rel = relativeToDir(target, name);
        if (eventType === 'rename') {
          // rename 事件表示文件被创建或删除，通过实际存在性区分
          queue(rel, existsSync(join(target, name)) ? 'add' : 'remove');
        } else {
          queue(rel, 'change');
        }
      });
      watchers.push(w);
    } catch {
      // 监听失败（目录不存在或权限不足），忽略，交给 TTL 校准兜底
    }
  }

  /** 计算相对存储目录的路径 */
  function relativeToDir(target: string, name: string): string {
    if (target === dir) return name;
    const prefix = target.slice(dir.length).replace(/^[\\/]+/, '');
    return prefix ? `${prefix}/${name}` : name;
  }

  /** 建立对存储目录及其子目录的监听 */
  function setupWatch(): void {
    if (!watchEnabled) return;
    // 监听顶层目录
    watchDir(dir);
    // 监听一级子目录（更深层级由 TTL 校准兜底，避免 watcher 数量失控）
    try {
      for (const name of readdirSync(dir)) {
        if (isInternalDirName(name)) continue;
        const full = join(dir, name);
        try {
          if (statSync(full).isDirectory()) watchDir(full);
        } catch {
          // 忽略读取失败的条目
        }
      }
    } catch {
      // 目录读取失败，忽略
    }
  }

  return {
    list(): FileEntry[] {
      const expired = !loaded || Date.now() - lastScan > ttl;
      if (expired) {
        misses++;
        scan();
        // 重新扫描后重新建立监听，覆盖新增的子目录
        if (watchEnabled) {
          for (const w of watchers) {
            try {
              w.close();
            } catch {
              // 忽略关闭失败
            }
          }
          watchers.length = 0;
          setupWatch();
        }
        return entries;
      }
      hits++;
      // 应用待处理的增量变更
      if (pending.size) flush();
      return entries;
    },

    startWatch(): void {
      if (!watchEnabled) return;
      setupWatch();
    },

    refresh(): FileEntry[] {
      misses++;
      return scan();
    },

    invalidate(): void {
      loaded = false;
      pending.clear();
    },

    stats() {
      return { entries: entries.length, hits, misses, watching: watchers.length > 0, lastScan };
    },

    stop(): void {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // 忽略关闭失败
        }
      }
      watchers.length = 0;
      if (flushTimer) clearTimeout(flushTimer);
    },
  };
}
