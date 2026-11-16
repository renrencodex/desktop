/**
 * Metrics / Events 面板纯逻辑（无 React 依赖，便于 bun test）：
 * - 采样点环形缓冲（固定容量，先进先出）；
 * - 百分比 / uptime / 事件 payload 摘要格式化；
 * - SVG 火花线折线点串生成。
 */

import { formatBytes } from "./fs-utils";

export { MAX_MACHINE_METRICS_SAMPLES as MAX_METRICS_SAMPLES } from "@cloud-machine/workspace-ui/machine-metrics-cache";

/** 1 秒刷新，150 点覆盖最近 2.5 分钟。 */
export const METRICS_POLL_INTERVAL_MS = 1000;

/** A running VM can still be waiting for its communication service after boot/restore. */
export function isMetricsConnectionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    ["MACHINE_OFFLINE", "RPC_CLOSED", "CONNECT_FAILED"].includes(error.code)
  );
}

export interface MetricsPollerOptions<T> {
  poll: () => Promise<T>;
  onSample: (sample: T) => void;
  onError: (error: unknown) => void;
  isVisible: () => boolean;
}

/** 单飞轮询控制器：隐藏/停止时跳过，慢请求未完成时不叠加下一次请求。 */
export function createMetricsPoller<T>(options: MetricsPollerOptions<T>) {
  let stopped = false;
  let inFlight = false;
  return {
    async tick(): Promise<void> {
      if (stopped || inFlight || !options.isVisible()) return;
      inFlight = true;
      try {
        const sample = await options.poll();
        if (!stopped) options.onSample(sample);
      } catch (error) {
        if (!stopped) options.onError(error);
      } finally {
        inFlight = false;
      }
    },
    stop(): void {
      stopped = true;
    },
  };
}

/** 向采样缓冲追加一个点，超出容量时丢弃最旧点。返回新数组（不原地修改）。 */
export function appendSample<T>(samples: readonly T[], sample: T, capacity: number): T[] {
  const next = [...samples, sample];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

/** 0..1 → "37%"；越界钳制到 0..100。 */
export function formatPercent(ratio: number): string {
  const clamped = Math.min(1, Math.max(0, ratio));
  return `${Math.round(clamped * 100)}%`;
}

/** 每秒字节数 → 人类可读速率。 */
export function formatByteRate(bytesPerSecond: number): string {
  const safeValue = Number.isFinite(bytesPerSecond) ? Math.max(0, Math.round(bytesPerSecond)) : 0;
  return `${formatBytes(safeValue)}/s`;
}

/** 接收和发送序列按共同峰值归一化，保留两条曲线的相对量级。 */
export function normalizeNetworkSeries(
  receive: readonly number[],
  transmit: readonly number[],
): { receive: number[]; transmit: number[] } {
  const sanitize = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0);
  const maximum = Math.max(1, ...receive.map(sanitize), ...transmit.map(sanitize));
  return {
    receive: receive.map((value) => sanitize(value) / maximum),
    transmit: transmit.map((value) => sanitize(value) / maximum),
  };
}

/** 秒 → 人类可读时长："2 天 3 小时" / "4 小时 12 分钟" / "9 分钟" / "42 秒"。 */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${s} 秒`;
}

/**
 * 火花线折线点串（SVG polyline points）：values 为 0..1 采样，
 * 映射到 width×height 视窗（y 轴翻转，0 在底部）。少于 2 个点返回空串。
 * 有时间戳时按实际间隔分布，避免混合刷新频率或短暂断线被绘制成等距点。
 */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
  timestamps?: readonly number[],
): string {
  if (values.length < 2) return "";
  const start = timestamps?.[0] ?? 0;
  const duration = timestamps ? timestamps[timestamps.length - 1]! - start : values.length - 1;
  if (duration <= 0 || (timestamps && timestamps.length !== values.length)) return "";
  return values
    .map((v, i) => {
      const clamped = Math.min(1, Math.max(0, v));
      const offset = timestamps ? timestamps[i]! - start : i;
      const x = Math.round((offset / duration) * width * 100) / 100;
      const y = Math.round((1 - clamped) * height * 100) / 100;
      return `${x},${y}`;
    })
    .join(" ");
}
