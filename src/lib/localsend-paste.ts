/*
 * LocalSend 剪贴板内容落盘
 *
 * 分享目前只能分享「已经存在于存储目录里的文件」，
 * 想分享一段文字或一张截图，必须先手动存成文件才行。
 *
 * 这里把剪贴板内容（纯文本 / 截图）直接落盘成普通文件，
 * 这样就能复用既有的上传、列表、回收站、批量打包、WebDAV 等全部能力，
 * 前端拿到文件名后用现成的分享接口即可生成链接。
 *
 * 命名策略：
 *  - hash（默认）：内容 md5 前 8 位，同内容天然同名，便于识别与复用
 *  - timestamp：时间戳，便于一眼看出粘贴时间
 *  - custom：完全由调用方指定
 */
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { safeRelPath } from './localsend-path';

/** 剪贴板内容的类型 */
export type PasteKind = 'text' | 'image';

/** 文件名生成策略 */
export type NameStrategy = 'hash' | 'timestamp' | 'custom';

/** 允许粘贴的图片类型（不含 svg：脚本内容存在安全风险） */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

/** 纯文本内容的大小上限（字节），避免把整份日志塞进来 */
export const MAX_TEXT_SIZE = 1024 * 1024;

/** 文本落盘时使用的默认扩展名 */
export const TEXT_EXT = 'txt';

export interface PastePayload {
  /** 内容类型 */
  kind: PasteKind;
  /** 文本内容，或图片的 data URL */
  content: string;
  /** 自定义文件名（strategy 为 custom 时生效） */
  name?: string;
  /** 存放目录（相对存储目录），空表示根目录 */
  dir?: string;
  /** 命名策略 */
  strategy?: NameStrategy;
}

/** 解析后的落盘内容 */
export interface ParsedPaste {
  /** 文件内容 */
  buffer: Buffer;
  /** 扩展名（不含点） */
  ext: string;
  /** MIME 类型 */
  mime: string;
  /** 内容哈希（md5 前 8 位） */
  hash: string;
}

/** 取 MIME 对应的扩展名，不支持的类型返回空串 */
export function extOfMime(mime: string): string {
  return MIME_EXT[String(mime || '').toLowerCase()] ?? '';
}

/**
 * 解析 data URL（形如 `data:image/png;base64,xxxx`）。
 * 解析失败返回 null。
 */
export function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
  const matched = /^data:([\w./+-]+);base64,([\s\S]*)$/i.exec(String(dataUrl || '').trim());
  if (!matched) return null;
  const buffer = Buffer.from(matched[2], 'base64');
  if (!buffer.length) return null;
  return { mime: matched[1].toLowerCase(), buffer };
}

/** 内容哈希：md5 前 8 位，够短又足够区分不同内容 */
export function contentHash(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex').slice(0, 8);
}

/** 时间戳文件名片段，如 `20261118-221530` */
export function timeStampTag(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

/**
 * 解析落盘请求。
 *
 * 返回 `error` 时说明请求不合法，调用方据此给出提示。
 */
export function parsePaste(raw: unknown): { error?: string; kind: PasteKind; buffer: Buffer; ext: string; mime: string } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const kind: PasteKind = String(input.kind ?? 'text') === 'image' ? 'image' : 'text';
  const content = String(input.content ?? '');

  if (kind === 'image') {
    const parsed = parseDataUrl(content);
    if (!parsed) return { kind, buffer: Buffer.alloc(0), ext: '', mime: '', error: '不是有效的图片数据' };
    const ext = extOfMime(parsed.mime);
    if (!ext) return { kind, buffer: parsed.buffer, ext: '', mime: parsed.mime, error: `不支持的图片格式：${parsed.mime}` };
    return { kind, buffer: parsed.buffer, ext, mime: parsed.mime };
  }

  if (!content) return { kind, buffer: Buffer.alloc(0), ext: TEXT_EXT, mime: 'text/plain', error: '内容为空' };
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.length > MAX_TEXT_SIZE) {
    return { kind, buffer, ext: TEXT_EXT, mime: 'text/plain', error: `文本内容过大（上限 ${Math.floor(MAX_TEXT_SIZE / 1024)}KB）` };
  }
  return { kind, buffer, ext: TEXT_EXT, mime: 'text/plain' };
}

/**
 * 按策略生成文件名（不含目录）。
 *
 * custom 策略下若没给名字，会回退到 hash 策略，
 * 保证任何情况下都有一个合法且不会互相覆盖的名字。
 */
export function buildPasteName(
  options: { kind: PasteKind; hash: string; stamp: string; name?: string; strategy: NameStrategy },
  ext: string,
): string {
  const prefix = options.kind === 'image' ? '截图' : '文本';
  if (options.strategy === 'custom' && options.name) {
    const clean = safeRelPath(options.name);
    if (clean) {
      // 自定义名字只取文件名部分，目录由 dir 参数决定
      const file = basename(clean);
      return extname(file) ? file : `${file}.${ext}`;
    }
  }
  if (options.strategy === 'timestamp') return `${prefix}-${options.stamp}.${ext}`;
  return `${prefix}-${options.hash}.${ext}`;
}

/** 规范化命名策略，非法值回退到 hash */
export function parseStrategy(raw: unknown): NameStrategy {
  const value = String(raw ?? 'hash');
  return value === 'timestamp' || value === 'custom' ? value : 'hash';
}
