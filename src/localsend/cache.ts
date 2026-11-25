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
import { type FileEntry, isHiddenDirName, isInternalDirName, listFiles } from './path';

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

  /**
   * 应用一次增量变更。
   *
   * 返回是否真的对应一个文件条目：目录本身的创建/改名也会触发 watcher，
   * 这类事件不该被当成「收到新文件」推送出去。
   */
  function applyChange(rel: string, type: 'add' | 'change' | 'remove'): boolean {
    const filter = options.filter;
    if (type === 'remove') {
      const idx = findIndex(rel);
      if (idx >= 0) entries.splice(idx, 1);
      return false;
    }
    // 内部目录（如分片暂存区）不进入缓存
    if (rel.split('/').some((p) => isInternalDirName(p))) return false;
    if (filter && !filter(rel)) return false;
    const meta = statOf(rel);
    if (!meta) {
      // 文件可能已被删除，或者是目录事件
      const idx = findIndex(rel);
      if (idx >= 0) entries.splice(idx, 1);
      return false;
    }
    const idx = findIndex(rel);
    if (idx >= 0) entries[idx] = meta;
    else entries.push(meta);
    return true;
  }

  /** 合并并应用待处理的变更 */
  function flush(): void {
    flushTimer = null;
    if (!pending.size) return;
    const changed: string[] = [];
    for (const [rel, info] of pending) {
      const applied = applyChange(rel, info.type);
      // 删除不作为「收到新文件」通知；目录事件也不推送
      if (info.type !== 'remove' && applied) changed.push(rel);
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

  /** 计算相对存储目录的路径（统一用 `/` 分隔） */
  function relativeToDir(target: string, name: string): string {
    if (target === dir) return name;
    const prefix = target
      .slice(dir.length)
      .replace(/^[\\/]+/, '')
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/');
    return prefix ? `${prefix}/${name}` : name;
  }

  /** 监听上限：目录过多时只覆盖较浅的层级，更深的靠 TTL 兜底 */
  const MAX_WATCHERS = 64;
  /** 监听的最大层级（根目录算第 0 层） */
  const MAX_WATCH_DEPTH = 3;

  /**
   * 建立对存储目录及其子目录的监听。
   *
   * 以前只监听根目录与一级子目录，深层子目录里的新增文件要等 5 分钟 TTL
   * 过期才会被推送。这里按深度（默认 3 层）与数量（默认 64 个）递归监听，
   * 既覆盖常见的「归档/2026/项目」这类结构，也不会让 watcher 数量失控。
   */
  function setupWatch(): void {
    if (!watchEnabled) return;
    // 监听顶层目录
    watchDir(dir);
    const walk = (current: string, depth: number) => {
      if (depth >= MAX_WATCH_DEPTH || watchers.length >= MAX_WATCHERS) return;
      let names: string[];
      try {
        names = readdirSync(current);
      } catch {
        return;
      }
      for (const name of names) {
        if (isInternalDirName(name)) continue;
        if (watchers.length >= MAX_WATCHERS) return;
        const full = join(current, name);
        try {
          if (!statSync(full).isDirectory()) continue;
        } catch {
          // 忽略读取失败的条目
          continue;
        }
        // 点开头的隐藏目录不进列表，也就不必为它花掉监听预算
        if (isHiddenDirName(name)) continue;
        watchDir(full);
        walk(full, depth + 1);
      }
    };
    walk(dir, 0);
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
