/*
 * LocalSend 存储目录的路径处理
 *
 * 存储目录下可能存在子目录（上传文件夹时保留相对路径），
 * 因此所有对外接口都用「相对路径」标识文件，如 `子目录/照片.jpg`。
 * 这里统一做规范化与安全校验，杜绝目录穿越。
 */
import { existsSync, readdirSync, type Stats, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** 存储目录中允许出现的最大层级，避免异常深的目录 */
const MAX_DEPTH = 16;

/**
 * 内部目录名（位于存储目录下，但不参与文件列表、WebDAV 目录浏览与自动清理）。
 * 用于存放分片上传的临时分片等内部数据。
 */
export const INTERNAL_DIR_NAMES = ['.chunks'];

/** 判断目录名是否为内部目录 */
export function isInternalDirName(name: string): boolean {
  return INTERNAL_DIR_NAMES.includes(name);
}

/**
 * 规范化相对路径：去掉首尾空白与多余分隔符，拒绝 `..`、绝对路径与盘符。
 * 返回以 `/` 分隔的相对路径，非法时返回空串。
 */
export function safeRelPath(input?: unknown): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  // 统一分隔符，并去掉开头的斜杠（不允许绝对路径）
  const parts = raw.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (!parts.length) return '';
  if (parts.length > MAX_DEPTH) return '';
  const safe: string[] = [];
  for (const part of parts) {
    // 拒绝上级目录穿越与盘符
    if (part === '..' || part.includes(':')) return '';
    // 拒绝控制字符
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 需要过滤控制字符
    if (/[\u0000-\u001f]/.test(part)) return '';
    safe.push(part);
  }
  return safe.join('/');
}

/**
 * 把相对路径解析为绝对路径，并确保结果仍在存储目录内。
 * 非法时返回空串。
 */
export function resolveInDir(baseDir: string, relPath: string): string {
  const rel = safeRelPath(relPath);
  if (!rel) return '';
  // 内部目录（如分片暂存区）不对外暴露
  if (rel.split('/').some((part) => isInternalDirName(part))) return '';
  const base = resolve(baseDir);
  const full = resolve(base, ...rel.split('/'));
  // 二次校验，防止符号链接或边界情况越界
  const inside = relative(base, full);
  if (!inside || inside.startsWith('..') || resolve(base, inside) !== full) return '';
  if (full === base) return '';
  return full;
}

export interface FileEntry {
  /** 相对路径，使用 `/` 分隔 */
  name: string;
  size: number;
  mtime: number;
  ext: string;
  isDir: boolean;
}

/**
 * 递归扫描存储目录，返回所有文件的相对路径列表（不含目录）。
 */
export function listFiles(baseDir: string, filter?: (relPath: string) => boolean): FileEntry[] {
  const entries: FileEntry[] = [];
  if (!existsSync(baseDir)) return entries;

  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let stat: Stats;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        // 内部目录（如分片暂存区）不对外暴露
        if (isInternalDirName(name)) continue;
        walk(full, rel, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      if (filter && !filter(rel)) continue;
      entries.push({
        name: rel,
        size: stat.size,
        mtime: stat.mtimeMs,
        ext: name.slice(name.lastIndexOf('.') + 1).toLowerCase(),
        isDir: false,
      });
    }
  };

  walk(baseDir, '', 0);
  return entries;
}

/** 目录下的直接子目录（相对路径） */
export function listDirs(baseDir: string): string[] {
  if (!existsSync(baseDir)) return [];
  const dirs: string[] = [];
  for (const name of readdirSync(baseDir)) {
    try {
      if (statSync(join(baseDir, name)).isDirectory()) dirs.push(name);
    } catch {
      // 忽略无法读取的条目
    }
  }
  return dirs;
}

/** 判断路径是否位于指定目录内（用于二次校验） */
export function isInsideDir(baseDir: string, target: string): boolean {
  const rel = relative(resolve(baseDir), resolve(target));
  return !!rel && !rel.startsWith('..') && !rel.startsWith(sep);
}
