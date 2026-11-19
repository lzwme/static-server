/*
 * LocalSend 的文件整理（重命名 / 移动 / 批量重命名）
 *
 * 这里只做「纯文件操作」：整理结果直接体现在真实的目录结构上，
 * 不引入任何元数据存储，回收站、分享、WebDAV 等既有能力都自动跟随。
 *
 * 所有操作都以「存储目录内的相对路径」为单位，越界路径一律拒绝；
 * 目标重名时自动追加 `_1` 后缀，与上传时的处理保持一致。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { resolveInDir, safeRelPath } from './path';
import { ROOT_DIR } from './query';

/** 批量重命名支持的规则类型 */
export type RenameMode = 'prefix' | 'suffix' | 'replace' | 'sequence';

export interface RenameRule {
  /** 规则类型 */
  mode: RenameMode;
  /** prefix：添加到文件名之前 */
  prefix?: string;
  /** suffix：添加到文件名之后 */
  suffix?: string;
  /** replace：查找的文本 */
  find?: string;
  /** replace：替换成的文本 */
  replace?: string;
  /** sequence：起始序号 */
  start?: number;
  /** sequence：序号补零位数 */
  padding?: number;
  /** sequence：名称模板，{n} 代表序号、{name} 代表原文件名，默认「{n}」 */
  template?: string;
  /** 只处理该扩展名的文件（不含点，小写），空表示全部 */
  ext?: string;
}

/** 一次成功的文件操作 */
export interface MoveResult {
  /** 原相对路径 */
  from: string;
  /** 操作后的相对路径 */
  to: string;
}

/** 一次失败的文件操作 */
export interface MoveFailure {
  /** 文件相对路径 */
  name: string;
  /** 失败原因 */
  msg: string;
}

/** 批量移动的结果 */
export interface MoveOutcome {
  moved: MoveResult[];
  failed: MoveFailure[];
}

/** 批量重命名的结果 */
export interface BatchRenameOutcome {
  renamed: MoveResult[];
  /** 名称未变化或不符合扩展名过滤条件而跳过的文件 */
  skipped: string[];
  failed: MoveFailure[];
}

/** 本批次已占用的相对路径集合，避免批内重名 */
export type TakenSet = Set<string>;

/**
 * 同名文件自动追加 _1/_2 后缀（支持子目录，相对路径用 `/` 分隔）。
 *
 * taken 用于把本批次已经占用的名字也算作冲突，
 * 让批量操作不会把后面的文件顶掉前面的。
 */
export function uniqueName(baseDir: string, relName: string, taken?: TakenSet): string {
  const rel = safeRelPath(relName);
  if (!rel) return '';
  const parts = rel.split('/');
  const fileName = parts.pop() as string;
  const subDir = join(baseDir, ...parts);
  const ext = extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  let finalName = fileName;
  let i = 1;
  while (existsSync(join(subDir, finalName)) || (taken?.has(parts.length ? `${parts.join('/')}/${finalName}` : finalName) ?? false)) {
    finalName = `${base}_${i}${ext}`;
    i += 1;
  }
  return parts.length ? `${parts.join('/')}/${finalName}` : finalName;
}

/**
 * 解析批量重命名规则，非法字段一律收敛到安全默认值。
 */
export function parseRenameRule(raw: unknown): RenameRule {
  const input = (raw ?? {}) as Record<string, unknown>;
  const modeRaw = String(input.mode ?? 'prefix');
  const mode: RenameMode = modeRaw === 'suffix' || modeRaw === 'replace' || modeRaw === 'sequence' ? modeRaw : 'prefix';
  const start = Number(input.start);
  const padding = Number(input.padding);
  return {
    mode,
    prefix: String(input.prefix ?? ''),
    suffix: String(input.suffix ?? ''),
    find: String(input.find ?? ''),
    replace: String(input.replace ?? ''),
    start: Number.isFinite(start) ? Math.trunc(start) : 1,
    padding: Number.isFinite(padding) ? Math.min(Math.max(Math.trunc(padding), 0), 10) : 0,
    template: String(input.template ?? '{n}'),
    ext: String(input.ext ?? '')
      .trim()
      .replace(/^\./, '')
      .toLowerCase(),
  };
}

/**
 * 把重命名规则应用到文件名（不含扩展名）上。
 *
 * sequence 模式的模板支持两个占位符：
 *  - {n}：序号（按 padding 补零）
 *  - {name}：原文件名
 */
export function applyRenameRule(base: string, rule: RenameRule, index: number): string {
  switch (rule.mode) {
    case 'prefix':
      return `${rule.prefix ?? ''}${base}`;
    case 'suffix':
      return `${base}${rule.suffix ?? ''}`;
    case 'replace': {
      const find = rule.find ?? '';
      // 查找为空时不做替换，避免把整段名字清掉
      if (!find) return base;
      return base.split(find).join(rule.replace ?? '');
    }
    case 'sequence': {
      const start = rule.start ?? 1;
      const num = rule.padding ? String(start + index).padStart(rule.padding, '0') : String(start + index);
      return (rule.template || '{n}').replace('{n}', num).replace('{name}', base);
    }
    default:
      return base;
  }
}

/**
 * 重命名（或移动）单个文件。
 *
 * to 可以是「同目录下的新文件名」，也可以是「目录/新文件名」，
 * 后者即跨目录移动；目标已存在时自动追加 `_1` 后缀。
 */
export function renameFile(baseDir: string, from: string, to: string): { code: number; msg?: string; from?: string; to?: string } {
  const srcRel = safeRelPath(from);
  if (!srcRel) return { code: 1, msg: '非法的文件路径' };
  const srcAbs = resolveInDir(baseDir, srcRel);
  if (!srcAbs || !existsSync(srcAbs)) return { code: 1, msg: '文件不存在' };

  const rawTo = String(to ?? '').trim();
  if (!rawTo) return { code: 1, msg: '请填写新的名称' };
  let targetRel = safeRelPath(rawTo);
  if (!targetRel) return { code: 1, msg: '非法的目标名称' };

  // 目标以分隔符结尾，或指向一个已存在的目录时，视为「移动到该目录」
  const looksLikeDir = rawTo.endsWith('/') || rawTo.endsWith('\\');
  const candidateAbs = resolveInDir(baseDir, targetRel);
  if (looksLikeDir || (candidateAbs && existsSync(candidateAbs) && statSync(candidateAbs).isDirectory())) {
    targetRel = `${targetRel}/${basename(srcRel)}`;
  }

  const dstAbs = resolveInDir(baseDir, targetRel);
  if (!dstAbs) return { code: 1, msg: '非法的目标路径' };
  // 名称没有变化时不做任何事
  if (dstAbs === srcAbs) return { code: 0, from: srcRel, to: srcRel };

  const finalRel = uniqueName(baseDir, targetRel);
  const finalAbs = resolveInDir(baseDir, finalRel);
  if (!finalAbs) return { code: 1, msg: '非法的目标路径' };
  try {
    mkdirSync(dirname(finalAbs), { recursive: true });
    renameSync(srcAbs, finalAbs);
  } catch {
    return { code: 1, msg: '重命名失败' };
  }
  return { code: 0, from: srcRel, to: finalRel };
}

/**
 * 把多个文件移动到指定目录。
 *
 * dir 为空或 ROOT_DIR 表示移动到根目录，目标目录不存在时自动创建；
 * 同名文件自动追加 `_1` 后缀。
 */
export function moveFiles(baseDir: string, names: string[], dir: string): MoveOutcome {
  const moved: MoveResult[] = [];
  const failed: MoveFailure[] = [];
  const rawDir = String(dir ?? '').trim();
  const targetDir = rawDir && rawDir !== ROOT_DIR ? safeRelPath(rawDir) : '';
  if (rawDir && rawDir !== ROOT_DIR && !targetDir) {
    return { moved, failed: names.map((n) => ({ name: String(n), msg: '非法的目标目录' })) };
  }

  const taken: TakenSet = new Set();
  for (const raw of names) {
    const rel = safeRelPath(raw);
    if (!rel) {
      failed.push({ name: String(raw), msg: '非法的文件路径' });
      continue;
    }
    const src = resolveInDir(baseDir, rel);
    if (!src || !existsSync(src)) {
      failed.push({ name: rel, msg: '文件不存在' });
      continue;
    }
    const fileName = basename(rel);
    const destRel = targetDir ? `${targetDir}/${fileName}` : fileName;
    const destAbs = resolveInDir(baseDir, destRel);
    if (!destAbs) {
      failed.push({ name: rel, msg: '非法的目标路径' });
      continue;
    }
    // 已经在目标目录里，无需移动
    if (destAbs === src) {
      moved.push({ from: rel, to: rel });
      continue;
    }
    const finalRel = uniqueName(baseDir, destRel, taken);
    const finalAbs = resolveInDir(baseDir, finalRel);
    if (!finalAbs) {
      failed.push({ name: rel, msg: '非法的目标路径' });
      continue;
    }
    try {
      mkdirSync(dirname(finalAbs), { recursive: true });
      renameSync(src, finalAbs);
      taken.add(finalRel);
      moved.push({ from: rel, to: finalRel });
    } catch {
      failed.push({ name: rel, msg: '移动失败' });
    }
  }
  return { moved, failed };
}

/**
 * 按规则批量重命名。
 *
 * 先把所有文件改成一个临时名，再改回最终名，
 * 这样「a→b、b→c」这类互相覆盖的情况也能正确处理，
 * 中途异常时临时名会被既有的临时文件清理机制回收。
 */
export function batchRename(baseDir: string, names: string[], rule: RenameRule): BatchRenameOutcome {
  const renamed: MoveResult[] = [];
  const skipped: string[] = [];
  const failed: MoveFailure[] = [];

  interface Item {
    rel: string;
    abs: string;
    finalRel: string;
  }
  const items: Item[] = [];

  // 先筛出可以处理的文件
  for (const raw of names) {
    const rel = safeRelPath(raw);
    if (!rel) {
      failed.push({ name: String(raw), msg: '非法的文件路径' });
      continue;
    }
    const abs = resolveInDir(baseDir, rel);
    if (!abs || !existsSync(abs)) {
      failed.push({ name: rel, msg: '文件不存在' });
      continue;
    }
    const fileName = basename(rel);
    if (rule.ext && !fileName.toLowerCase().endsWith(`.${rule.ext}`)) {
      skipped.push(rel);
      continue;
    }
    items.push({ rel, abs, finalRel: rel });
  }

  // 计算每个文件的新名字
  let seq = 0;
  for (const item of items) {
    const fileName = basename(item.rel);
    const ext = extname(fileName);
    const base = fileName.slice(0, fileName.length - ext.length);
    const newBase = applyRenameRule(base, rule, seq);
    seq += 1;
    const parent = dirname(item.rel);
    const dirPrefix = parent === '.' ? '' : `${parent}/`;
    const targetRel = `${dirPrefix}${newBase}${ext}`;
    // 名字没变就不动它
    if (targetRel === item.rel) {
      skipped.push(item.rel);
      continue;
    }
    item.finalRel = targetRel;
  }

  const targets = items.filter((i) => i.finalRel !== i.rel);
  if (!targets.length) return { renamed, skipped, failed };

  // 最终名要同时避开批内重名与批外的既有文件
  const currentNames = new Set(targets.map((i) => i.rel));
  const taken: TakenSet = new Set();
  for (const item of targets) {
    const parts = item.finalRel.split('/');
    const fileName = parts.pop() as string;
    const ext = extname(fileName);
    const base = fileName.slice(0, fileName.length - ext.length);
    const dirPrefix = parts.length ? `${parts.join('/')}/` : '';
    // 批内文件会先被改成临时名，因此只把「批外已存在的文件」视为冲突
    const existsOutsideBatch = (rel: string) => {
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      return existsSync(join(baseDir, ...parts, name)) && !currentNames.has(rel);
    };
    let candidate = `${dirPrefix}${fileName}`;
    let i = 1;
    while (taken.has(candidate) || existsOutsideBatch(candidate)) {
      candidate = `${dirPrefix}${base}_${i}${ext}`;
      i += 1;
    }
    item.finalRel = candidate;
    taken.add(candidate);
  }

  // 第一步：统一改成临时名
  const staged: { tempAbs: string; finalAbs: string; item: Item }[] = [];
  for (const item of targets) {
    const tempName = randomBytes(16).toString('hex');
    const tempAbs = join(dirname(item.abs), tempName);
    try {
      renameSync(item.abs, tempAbs);
      staged.push({ tempAbs, finalAbs: resolveInDir(baseDir, item.finalRel), item });
    } catch {
      failed.push({ name: item.rel, msg: '重命名失败' });
    }
  }

  // 第二步：改回最终名
  for (const stage of staged) {
    const finalAbs = stage.finalAbs;
    if (!finalAbs) {
      failed.push({ name: stage.item.rel, msg: '非法的目标路径' });
      continue;
    }
    try {
      mkdirSync(dirname(finalAbs), { recursive: true });
      renameSync(stage.tempAbs, finalAbs);
      renamed.push({ from: stage.item.rel, to: stage.item.finalRel });
    } catch {
      failed.push({ name: stage.item.rel, msg: '重命名失败' });
    }
  }

  return { renamed, skipped, failed };
}
