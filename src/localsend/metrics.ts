/*
 * LocalSend 运行指标
 *
 * 只做最朴素的两件事：计数与耗时分布。
 * 目的不是做监控系统，而是让「为什么大家传不上去」「合并慢不慢」这类问题
 * 能用一个接口回答，而不是靠用户口述。
 *
 * 耗时只保留最近 N 次采样（环形裁剪），因此内存占用恒定。
 */

/** 一组耗时的概要统计 */
export interface TimerSummary {
  count: number;
  /** 最近采样的中位数（毫秒） */
  p50: number;
  /** 最近采样的 95 分位（毫秒） */
  p95: number;
  max: number;
}

export interface MetricsSnapshot {
  /** 服务启动时间戳 */
  startedAt: number;
  /** 计数器 */
  counters: Record<string, number>;
  /** 耗时统计 */
  timers: Record<string, TimerSummary>;
}

export interface Metrics {
  /** 计数 +1 或 +n */
  inc: (name: string, value?: number) => void;
  /** 记录一次耗时（毫秒） */
  observe: (name: string, ms: number) => void;
  /** 读取快照 */
  snapshot: () => MetricsSnapshot;
}

/** 每个耗时指标的采样上限：足够算分位，又不会无限增长 */
const MAX_SAMPLES = 200;

/** 计算分位（入参需已排序） */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

export function createMetrics(): Metrics {
  const counters = new Map<string, number>();
  const timers = new Map<string, number[]>();
  const startedAt = Date.now();

  return {
    inc(name, value = 1) {
      counters.set(name, (counters.get(name) || 0) + value);
    },

    observe(name, ms) {
      if (!Number.isFinite(ms) || ms < 0) return;
      const list = timers.get(name) || [];
      list.push(ms);
      // 超出上限时丢掉最早的采样，保持内存恒定
      if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
      timers.set(name, list);
    },

    snapshot() {
      const timerOut: Record<string, TimerSummary> = {};
      for (const [name, list] of timers) {
        const sorted = list.slice().sort((a, b) => a - b);
        timerOut[name] = {
          count: list.length,
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          max: Math.round((sorted[sorted.length - 1] || 0) * 10) / 10,
        };
      }
      return {
        startedAt,
        counters: Object.fromEntries(counters),
        timers: timerOut,
      };
    },
  };
}
