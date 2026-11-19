/*
 * LocalSend 自动清理
 *
 * 接收端长期开着时，存储目录会不断膨胀，最终把磁盘撑满。
 * 这里支持两种清理策略：
 *  - 按保留天数：删除超过指定天数的文件
 *  - 按容量上限：目录总容量超过上限时，从最旧的文件开始删除
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles } from './path';

export interface CleanerOptions {
  /** 存储目录 */
  dir: string;
  /** 保留天数，超过该天数的文件会被删除。传入函数表示运行时取值 */
  maxAgeDays?: number | (() => number);
  /** 容量上限（字节），超出后从最旧的文件开始删除。传入函数表示运行时取值 */
  maxTotalSize?: number | (() => number);
  /** 检查间隔（毫秒），默认 1 小时 */
  intervalMs?: number;
  /** 删除回调，用于记录日志 */
  onRemoved?: (names: string[]) => void;
}

export interface Cleaner {
  /** 立即执行一次清理，返回被删除的文件名列表 */
  run: () => string[];
  /** 停止定时检查 */
  stop: () => void;
}

export function createCleaner(options: CleanerOptions): Cleaner {
  const { dir, intervalMs = 60 * 60 * 1000, onRemoved } = options;
  /** 运行时读取当前生效的保留天数 */
  const getMaxAgeDays = (): number => {
    const value = typeof options.maxAgeDays === 'function' ? options.maxAgeDays() : options.maxAgeDays;
    return value ?? 0;
  };
  /** 运行时读取当前生效的容量上限 */
  const getMaxTotalSize = (): number => {
    const value = typeof options.maxTotalSize === 'function' ? options.maxTotalSize() : options.maxTotalSize;
    return value ?? 0;
  };

  const run = (): string[] => {
    const removed: string[] = [];
    const files = listFiles(dir);
    if (!files.length) return removed;

    const maxAgeDays = getMaxAgeDays();
    const maxTotalSize = getMaxTotalSize();

    // 1. 按保留天数删除
    if (maxAgeDays > 0) {
      const deadline = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      for (const file of files) {
        if (file.mtime >= deadline) continue;
        try {
          rmSync(join(dir, ...file.name.split('/')));
          removed.push(file.name);
        } catch {
          // 忽略删除失败（如文件正在被占用）
        }
      }
    }

    // 2. 按容量上限删除（从最旧的文件开始）
    if (maxTotalSize > 0) {
      const rest = listFiles(dir).sort((a, b) => a.mtime - b.mtime);
      let total = rest.reduce((sum, f) => sum + f.size, 0);
      for (const file of rest) {
        if (total <= maxTotalSize) break;
        try {
          rmSync(join(dir, ...file.name.split('/')));
          removed.push(file.name);
          total -= file.size;
        } catch {
          // 忽略删除失败
        }
      }
    }

    if (removed.length && onRemoved) onRemoved(removed);
    return removed;
  };

  const timer = setInterval(() => {
    try {
      run();
    } catch {
      // 清理失败不影响服务
    }
  }, intervalMs);
  timer.unref?.();

  return { run, stop: () => clearInterval(timer) };
}
