/*
 * LocalSend 运行时设置
 *
 * 配置文件（ss.config.js）里的设置要改完再重启才生效，
 * 而局域网里的这台机器未必方便远程登录去改文件。
 * 这里把「允许运行时修改」的设置单独存成一份 JSON，
 * 管理员在网页端验证身份后即可修改，改完立即生效。
 *
 * 优先级：配置文件 < 运行时设置。
 *
 * 若配置文件里的对应项被改过（与上次修改运行时设置时的基准值不同），
 * 说明用户更希望以配置文件为准，此时自动放弃该项的运行时覆盖，
 * 避免「改了配置文件却没生效」这种困惑。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getUserConfigDir } from '../config';

/** 允许运行时修改的配置项 */
export type SettingKey =
  | 'token'
  | 'password'
  | 'visitorPassword'
  | 'sessionTtl'
  | 'maxSize'
  | 'maxTotalSize'
  | 'maxConcurrent'
  | 'rateLimit'
  | 'blockExtensions'
  | 'trashDays'
  | 'autoCleanDays'
  | 'autoCleanMaxSize';

export interface SettingDef {
  /** 中文名称 */
  label: string;
  /** 取值形态 */
  kind: 'secret' | 'text' | 'number' | 'numberList' | 'rate';
  /** 单位说明，用于界面提示 */
  unit?: string;
  /** 数值下界 */
  min?: number;
  /** 数值上界 */
  max?: number;
  /** 说明 */
  desc: string;
  /** 是否为敏感值（接口返回时脱敏） */
  secret?: boolean;
}

/** 各配置项的元信息，网页端按这份定义渲染表单 */
export const SETTING_DEFS: Record<SettingKey, SettingDef> = {
  token: {
    label: '访问令牌',
    kind: 'secret',
    desc: '页面与所有接口都需要携带的钥匙。留空表示不启用令牌保护。修改后旧链接立即失效，需要重新扫码访问。',
    secret: true,
  },
  password: {
    label: '管理员口令',
    kind: 'secret',
    desc: '删除文件、整理目录、撤销分享等危险操作需要它。留空表示不启用口令（回到开放模式）。',
    secret: true,
  },
  visitorPassword: {
    label: '访客口令',
    kind: 'secret',
    desc: '访客可上传下载，但不能删除与整理。留空表示不启用访客身份。',
    secret: true,
  },
  sessionTtl: {
    label: '会话有效期',
    kind: 'number',
    unit: '毫秒',
    min: 60_000,
    max: 30 * 24 * 60 * 60 * 1000,
    desc: '登录后保持有效的时长，默认 24 小时。',
  },
  maxSize: {
    label: '单文件大小上限',
    kind: 'number',
    unit: '字节',
    min: 0,
    max: 1024 * 1024 * 1024 * 1024,
    desc: '单个文件允许上传的最大体积，0 表示不限制。',
  },
  maxTotalSize: {
    label: '存储容量上限',
    kind: 'number',
    unit: '字节',
    min: 0,
    max: 1024 * 1024 * 1024 * 1024,
    desc: '存储目录总容量上限，0 表示不限制。',
  },
  maxConcurrent: {
    label: '并发上传数',
    kind: 'number',
    unit: '个/IP',
    min: 0,
    max: 100,
    desc: '单个 IP 同时进行的上传数上限，0 表示不限制。',
  },
  rateLimit: {
    label: '请求频率限制',
    kind: 'rate',
    desc: '单个 IP 在滑动窗口内的最大请求数，0 表示不限制。',
  },
  blockExtensions: {
    label: '禁止上传的扩展名',
    kind: 'numberList',
    desc: '列出后缀名（如 .php），命中则拒绝上传。留空表示不拦截。',
  },
  trashDays: {
    label: '回收站保留天数',
    kind: 'number',
    unit: '天',
    min: 0,
    max: 3650,
    desc: '删除的文件在回收站保留多久，到期自动清理。',
  },
  autoCleanDays: {
    label: '自动清理天数',
    kind: 'number',
    unit: '天',
    min: 0,
    max: 3650,
    desc: '超过该天数的文件自动删除，0 表示关闭。',
  },
  autoCleanMaxSize: {
    label: '自动清理容量上限',
    kind: 'number',
    unit: '字节',
    min: 0,
    max: 1024 * 1024 * 1024 * 1024,
    desc: '存储目录超过该容量时，从最旧的文件开始删除，0 表示关闭。',
  },
};

/** 需要重启服务才能生效的配置项（仅作展示，不可修改） */
export const RESTART_REQUIRED_KEYS = ['dir', 'webdav'] as const;

/** 运行时设置文件的内容 */
interface SettingsFile {
  /** 最后修改时间 */
  updatedAt: number;
  /** 覆盖值 */
  values: Partial<Record<SettingKey, unknown>>;
  /** 修改时的配置文件基准值 */
  bases: Partial<Record<SettingKey, unknown>>;
}

export interface SettingsStore {
  /** 设置文件路径 */
  readonly file: string;
  /** 读取运行时设置（损坏时忽略） */
  load: () => void;
  /** 把运行时设置合并到配置文件的值上，返回最终生效的配置 */
  apply: <T extends Record<string, unknown>>(base: T) => T;
  /** 写一项覆盖；value 为 undefined 表示清除覆盖，回到配置文件的值 */
  set: (key: SettingKey, value: unknown, baseValue: unknown) => void;
  /** 清除一项覆盖 */
  clear: (key: SettingKey) => void;
  /** 某一项当前的生效值 */
  effective: <T extends Record<string, unknown>>(base: T, key: SettingKey) => unknown;
  /** 某一项当前来自运行时覆盖还是配置文件 */
  source: (key: SettingKey) => 'runtime' | 'config';
  /** 列出全部被覆盖的配置项 */
  overridden: () => SettingKey[];
  /** 把内存中的状态落盘 */
  flush: () => void;
}

/** 运行时设置文件的默认位置：用户级配置目录下 */
export function resolveSettingsFile(): string {
  return process.env.SS_LOCALSEND_SETTINGS || join(getUserConfigDir(), 'localsend-settings.json');
}

/**
 * 校验并规范化一个配置项的取值。
 * 返回 error 表示取值不合法；返回 value 表示规范化后的值。
 */
export function normalizeSetting(key: SettingKey, raw: unknown): { value?: unknown; error?: string } {
  const def = SETTING_DEFS[key];
  switch (def.kind) {
    case 'secret': {
      if (raw === null || raw === undefined) return { value: '' };
      const text = String(raw);
      if (text.length > 512) return { error: `${def.label}过长（最多 512 个字符）` };
      return { value: text };
    }
    case 'number': {
      const num = Number(raw);
      if (!Number.isFinite(num)) return { error: `${def.label}必须是数字` };
      if (def.min !== undefined && num < def.min) return { error: `${def.label}不能小于 ${def.min}` };
      if (def.max !== undefined && num > def.max) return { error: `${def.label}不能大于 ${def.max}` };
      return { value: Math.floor(num) };
    }
    case 'numberList': {
      if (raw === null || raw === undefined || raw === '') return { value: [] as string[] };
      const list = Array.isArray(raw) ? raw : String(raw).split(/[,，\s]+/);
      const out: string[] = [];
      for (const item of list) {
        const text = String(item).trim().toLowerCase();
        if (!text) continue;
        const ext = text.startsWith('.') ? text : `.${text}`;
        if (!/^\.[a-z0-9]{1,16}$/.test(ext)) return { error: `「${text}」不是合法的扩展名` };
        if (!out.includes(ext)) out.push(ext);
      }
      if (out.length > 100) return { error: '最多允许 100 个扩展名' };
      return { value: out };
    }
    case 'rate': {
      const src = (raw || {}) as Record<string, unknown>;
      const windowMs = Number(src.windowMs ?? 60_000);
      const max = Number(src.max ?? 120);
      if (!Number.isFinite(windowMs) || windowMs < 1000) return { error: '频率限制的窗口不能小于 1000 毫秒' };
      if (!Number.isFinite(max) || max < 0) return { error: '频率限制的次数不能为负数' };
      return { value: { windowMs: Math.floor(windowMs), max: Math.floor(max) } };
    }
    default:
      return { error: '未知的配置项' };
  }
}

/** 两个值是否相等（用于比较基准值） */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || a === null || b === undefined || b === null) return !a && !b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function createSettingsStore(file = resolveSettingsFile()): SettingsStore {
  let data: SettingsFile = { updatedAt: 0, values: {}, bases: {} };

  /** 把数据落盘（先写临时文件再改名，避免写一半被读到） */
  function save(): void {
    try {
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmp, file);
    } catch {
      // 落盘失败不影响服务内存中的生效值
    }
  }

  const store: SettingsStore = {
    file,

    load() {
      data = { updatedAt: 0, values: {}, bases: {} };
      if (!existsSync(file)) return;
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return;
        const values = (parsed.values || {}) as Partial<Record<SettingKey, unknown>>;
        const bases = (parsed.bases || {}) as Partial<Record<SettingKey, unknown>>;
        for (const key of Object.keys(values) as SettingKey[]) {
          if (!(key in SETTING_DEFS)) continue;
          data.values[key] = values[key];
          data.bases[key] = bases[key];
        }
        data.updatedAt = Number(parsed.updatedAt) || 0;
      } catch {
        // 文件损坏时按没有覆盖处理
        data = { updatedAt: 0, values: {}, bases: {} };
      }
    },

    apply<T extends Record<string, unknown>>(base: T): T {
      const out = { ...base } as Record<string, unknown>;
      let dropped = false;
      for (const key of Object.keys(data.values) as SettingKey[]) {
        if (!(key in SETTING_DEFS)) continue;
        // 配置文件里这一项被改过 → 以配置文件为准，放弃运行时覆盖
        if (!sameValue(out[key], data.bases[key])) {
          delete data.values[key];
          delete data.bases[key];
          dropped = true;
          continue;
        }
        out[key] = data.values[key];
      }
      // 丢弃的覆盖项要同步落盘，避免下次启动重复判断
      if (dropped) save();
      return out as T;
    },
    set(key, value, baseValue) {
      if (value === undefined) {
        store.clear(key);
        return;
      }
      data.values[key] = value;
      data.bases[key] = baseValue;
      data.updatedAt = Date.now();
      save();
    },

    clear(key) {
      if (!(key in data.values)) return;
      delete data.values[key];
      delete data.bases[key];
      data.updatedAt = Date.now();
      save();
    },

    effective(base, key) {
      const merged = store.apply(base);
      return merged[key];
    },

    source(key) {
      return key in data.values ? 'runtime' : 'config';
    },

    overridden() {
      return Object.keys(data.values) as SettingKey[];
    },

    flush() {
      save();
    },
  };

  return store;
}
