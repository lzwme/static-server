/**
 * 配置文件合并策略。
 * 数组类型的配置项在合并时，按指定 key 匹配已有项并深度合并，而不是整体替换。
 * 未列出的数组配置项，由后加载的配置整体覆盖先加载的。
 */
const ARRAY_MERGE_KEYS: Record<string, string> = {
  proxyConfig: 'api',
};

export function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value instanceof RegExp || value instanceof Date) return false;
  return true;
}

/**
 * 将 source 深度合并到 target。
 * - 普通对象：递归合并
 * - 数组：按 ARRAY_MERGE_KEYS 中指定的 key 合并，否则整体覆盖
 * - 函数等非对象值：直接覆盖
 * - undefined 值：忽略，不覆盖已有配置
 */
export function mergeConfig<T extends Record<string, any>>(target: T, source?: Record<string, any> | null): T {
  const t = target as Record<string, any>;
  if (!isPlainObject(source)) return target;

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      const mergeKey = ARRAY_MERGE_KEYS[key];
      const prev = t[key];
      t[key] = mergeKey && Array.isArray(prev) ? mergeArrayByKey(prev, value, mergeKey) : value;
    } else if (isPlainObject(value)) {
      if (!isPlainObject(t[key])) t[key] = {};
      mergeConfig(t[key], value);
    } else {
      t[key] = value;
    }
  }

  return target;
}

/** 按 key 合并数组：同 key 的项深度合并，后者覆盖前者；新项追加到末尾 */
function mergeArrayByKey(prev: any[], next: any[], key: string): any[] {
  const result = [...prev];
  for (const item of next) {
    const index = result.findIndex((it) => isPlainObject(it) && isPlainObject(item) && it[key] === item[key]);
    if (index < 0) {
      result.push(item);
    } else if (isPlainObject(result[index]) && isPlainObject(item)) {
      result[index] = mergeConfig({ ...result[index] }, item);
    } else {
      result[index] = item;
    }
  }
  return result;
}
