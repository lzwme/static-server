/*
 * LocalSend 上传临时文件处理
 *
 * multer 落盘时会先写入一个 32 位十六进制的随机临时文件，成功后再重命名为用户文件名。
 * 若客户端中途断开或改名失败，这些临时文件会残留在存储目录里，
 * 并且会作为"文件"出现在文件列表中（无扩展名、名字是一串哈希）。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** multer 落盘时的临时文件名（32 位十六进制） */
export const TEMP_FILE_RE = /^[0-9a-f]{32}$/i;

/** 判断是否为上传临时文件 */
export function isTempFileName(name: string): boolean {
  return TEMP_FILE_RE.test(name);
}

/**
 * 清理上传残留的临时文件。
 * 只清理早于 minAge 的临时文件，避免误删正在上传中的文件。
 * 返回被删除的文件名列表。
 */
export function cleanupTempFiles(target: string, minAge = 60 * 60 * 1000): string[] {
  const removed: string[] = [];
  if (!existsSync(target)) return removed;
  const now = Date.now();
  for (const name of readdirSync(target)) {
    if (!isTempFileName(name)) continue;
    const full = join(target, name);
    try {
      const stat = statSync(full);
      if (!stat.isFile() || now - stat.mtimeMs < minAge) continue;
      rmSync(full);
      removed.push(name);
    } catch {
      // 文件可能刚被清理或正在写入，跳过
    }
  }
  return removed;
}
