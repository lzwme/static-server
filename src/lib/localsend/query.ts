/*
 * LocalSend 文件列表的查询解析与分页
 *
 * 文件多到几千个之后，一次性把整个列表塞给前端既慢又难用：
 *  - 网络传输量随文件数线性增长，手机端滚动会明显卡顿；
 *  - 搜索与目录筛选只能在浏览器里做，前端必须先拿到全量数据才能筛。
 *
 * 这里把「关键词 / 目录 / 扩展名 / 时间窗」全部下推到服务端，
 * 只返回当前需要的那一页，同时把符合条件的总数一并告诉前端，
 * 让分页控件能显示「第 X/Y 页 · 共 N 条」。
 */
import type { FileEntry } from './path';

/** 根目录筛选的占位值（真实目录名不会与它冲突） */
export const ROOT_DIR = '__root__';

/** 默认每页条数 */
export const DEFAULT_PAGE_SIZE = 50;

/** 允许的最大每页条数，避免一次返回过多数据拖垮浏览器 */
export const MAX_PAGE_SIZE = 500;

export interface ListQuery {
  /** 排序字段：time（修改时间）或 size（大小） */
  sort: 'time' | 'size';
  /** 是否升序 */
  asc: boolean;
  /** 页码，从 1 开始 */
  page: number;
  /** 每页条数 */
  pageSize: number;
  /** 搜索关键词（匹配相对路径，不区分大小写） */
  q: string;
  /** 目录筛选：空表示全部，ROOT_DIR 表示只看根目录 */
  dir: string;
  /** 扩展名筛选（不含点，小写）；空表示全部 */
  ext: string;
  /** 只看该时间点之后修改过的文件（毫秒时间戳），0 表示不限 */
  since: number;
}

export interface ListResult {
  /** 当前页的文件 */
  items: FileEntry[];
  /** 符合筛选条件的文件总数 */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页条数 */
  pageSize: number;
  /** 总页数（至少为 1） */
  totalPages: number;
}

/** 目录筛选项 */
export interface DirFacet {
  /** 目录的相对路径 */
  path: string;
  /** 该目录下的文件数 */
  count: number;
}

/** 扩展名筛选项 */
export interface ExtFacet {
  /** 扩展名（不含点，小写） */
  ext: string;
  /** 该类型的文件数 */
  count: number;
}

/**
 * 把任意输入规整成区间内的整数。
 *
 * 小于下限的值（负数、0 等）视为无效，回退到默认值；
 * 超过上限的值收敛到上限，避免一次拉取过多数据。
 */
function intOr(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return fallback;
  return Math.min(max, Math.floor(n));
}

/**
 * 解析列表查询参数。
 *
 * 所有参数都做区间与类型收敛，非法输入一律回退到默认值，
 * 避免一个越界的 page 或 pageSize 把服务端拖垮。
 */
export function parseListQuery(query: Record<string, unknown>): ListQuery {
  const sortRaw = String(query.sort ?? 'time').toLowerCase();
  const orderRaw = String(query.order ?? 'desc').toLowerCase();
  const sinceRaw = Number(query.since);
  return {
    sort: sortRaw === 'size' ? 'size' : 'time',
    asc: orderRaw === 'asc',
    page: intOr(query.page, 1, 1, 1_000_000),
    pageSize: intOr(query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    q: String(query.q ?? '')
      .trim()
      .toLowerCase(),
    dir: String(query.dir ?? '').trim(),
    ext: String(query.ext ?? '')
      .trim()
      .replace(/^\./, '')
      .toLowerCase(),
    since: Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0,
  };
}

/** 取文件所在目录（相对存储目录），根目录返回空串 */
export function dirOfName(name: string): string {
  const i = name.lastIndexOf('/');
  return i < 0 ? '' : name.slice(0, i);
}

/** 按查询条件过滤文件 */
export function filterEntries(entries: FileEntry[], query: ListQuery): FileEntry[] {
  return entries.filter((e) => {
    if (query.q && !e.name.toLowerCase().includes(query.q)) return false;
    if (query.ext && e.ext !== query.ext) return false;
    if (query.since && e.mtime < query.since) return false;
    if (query.dir) {
      const dir = dirOfName(e.name);
      // ROOT_DIR 只看根目录文件，其他取值要求文件的父目录完全匹配
      if (query.dir === ROOT_DIR ? dir !== '' : dir !== query.dir) return false;
    }
    return true;
  });
}

/**
 * 排序：主字段相同时按名称兜底，
 * 保证翻页过程中同一条记录不会在两页之间来回跳。
 */
export function sortEntries(entries: FileEntry[], sort: 'time' | 'size', asc: boolean): FileEntry[] {
  const sign = asc ? 1 : -1;
  return entries.slice().sort((a, b) => {
    const diff = sort === 'size' ? a.size - b.size : a.mtime - b.mtime;
    if (diff !== 0) return diff * sign;
    if (a.name === b.name) return 0;
    return a.name < b.name ? -sign : sign;
  });
}

/** 切片出当前页；页码越界时收敛到有效范围 */
export function paginate(items: FileEntry[], page: number, pageSize: number): ListResult {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(page, 1), totalPages);
  const start = (current - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total,
    page: current,
    pageSize,
    totalPages,
  };
}

/** 统计目录筛选项：每个目录下的文件数与根目录文件数 */
export function collectDirs(entries: FileEntry[]): { dirs: DirFacet[]; rootCount: number } {
  const counts = new Map<string, number>();
  let rootCount = 0;
  for (const e of entries) {
    const dir = dirOfName(e.name);
    if (!dir) {
      rootCount += 1;
      continue;
    }
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const dirs = [...counts.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path));
  return { dirs, rootCount };
}

/** 统计扩展名筛选项：按文件数从多到少排列 */
export function collectExts(entries: FileEntry[]): ExtFacet[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!e.ext) continue;
    counts.set(e.ext, (counts.get(e.ext) ?? 0) + 1);
  }
  return [...counts.entries()].map(([ext, count]) => ({ ext, count })).sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
}
