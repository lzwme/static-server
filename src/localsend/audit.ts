/*
 * LocalSend 操作审计
 *
 * 局域网共享盘最常被问的问题是「谁把文件删了」「谁改了口令」。
 * 这里只记录**改了东西的操作**（删除、整理、回收站、分享、设置、认证），
 * 不记录浏览与下载，避免日志被正常使用刷满。
 *
 * 几个刻意的设计：
 *  - JSON Lines：一行一条，追加写入，坏一行不影响其它行
 *  - 写在用户配置目录，**不进存储目录**：因此不会被文件列表、配额、自动清理、
 *    WebDAV 看到，也不会被「清空回收站」一并带走
 *  - 绝不记录口令/令牌/会话，只记角色与动作
 *  - 任何写入失败都吞掉：审计不能反过来影响正常请求
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** 一条审计记录 */
export interface AuditEntry {
  /** 时间戳（毫秒） */
  ts: number;
  /** 来源 IP */
  ip: string;
  /** 操作者角色：admin / visitor / guest / open */
  role: string;
  /** 动作标识，如 file.rename、settings.update */
  action: string;
  /** 操作对象（文件相对路径、配置项名等） */
  target?: string;
  /** 补充信息（数量、来源等） */
  extra?: Record<string, unknown>;
}

export interface AuditOptions {
  /** 日志文件路径 */
  file: string;
  /** 单文件大小上限，超过后轮转，默认 5MB */
  maxBytes?: number;
}

export interface AuditLog {
  /** 日志文件路径 */
  readonly file: string;
  /** 追加一条记录 */
  record: (entry: Omit<AuditEntry, 'ts'> & { ts?: number }) => void;
  /** 最近的记录（从新到旧） */
  recent: (limit?: number) => AuditEntry[];
  /** 当前文件大小（诊断用） */
  size: () => number;
}

/** 默认单文件上限：5MB 约可容纳数万条记录 */
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
/** 默认返回条数 */
const DEFAULT_RECENT = 100;
/** 单条记录里 target 的最大长度，避免超长路径把日志撑大 */
const MAX_TARGET_LEN = 500;

export function createAuditLog(options: AuditOptions): AuditLog {
  const file = options.file;
  const maxBytes = options.maxBytes ?? AUDIT_MAX_BYTES;
  /** 内存中维护当前大小，避免每条都 stat */
  let size = 0;
  try {
    if (existsSync(file)) size = statSync(file).size;
  } catch {
    size = 0;
  }

  /** 轮转：当前文件改名为 .1，更早的直接丢弃（只保留一份历史） */
  function rotate(): void {
    try {
      const backup = `${file}.1`;
      rmSync(backup, { force: true });
      renameSync(file, backup);
    } catch {
      // 轮转失败就继续写当前文件，至少不丢记录
    }
    size = 0;
  }

  return {
    file,

    record(entry) {
      const line: AuditEntry = {
        ts: entry.ts ?? Date.now(),
        ip: entry.ip || 'unknown',
        role: entry.role || 'guest',
        action: entry.action,
        target: entry.target ? String(entry.target).slice(0, MAX_TARGET_LEN) : undefined,
        extra: entry.extra,
      };
      try {
        if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
        if (size >= maxBytes) rotate();
        const text = `${JSON.stringify(line)}\n`;
        appendFileSync(file, text, 'utf8');
        size += Buffer.byteLength(text);
      } catch {
        // 审计写入失败不影响请求
      }
    },

    recent(limit = DEFAULT_RECENT) {
      if (!existsSync(file)) return [];
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return [];
      }
      const lines = text.split('\n').filter(Boolean);
      const out: AuditEntry[] = [];
      // 从文件尾部往前取，坏行直接跳过
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try {
          const parsed = JSON.parse(lines[i]) as AuditEntry;
          if (parsed && typeof parsed.ts === 'number' && parsed.action) out.push(parsed);
        } catch {
          // 忽略损坏的行
        }
      }
      return out;
    },

    size() {
      return size;
    },
  };
}
