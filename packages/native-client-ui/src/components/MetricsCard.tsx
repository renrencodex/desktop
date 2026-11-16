/**
 * Overview 页签 Metrics 卡片（Phase 3 切片 3，设计文档 Phase 3 功能单 metrics）：
 * - 电脑通道在线（电脑 Running）时经 MachineRpcClient 每秒读取 agentd 指标缓存；
 *   概览隐藏时暂停 RPC，曲线保存在会话共享缓存中，重新打开时先恢复再更新；
 * - 主机信息先用会话缓存，连接成功后一次性拉 system.info 静默更新；
 * - CPU、内存、系统盘和主路由表默认路由网络速率以数字与轻量 SVG 火花线呈现（最近 150 个采样点）；
 * - 电脑通道离线 / 电脑非 Running 显示占位提示，不发起连接。
 *
 * 注意：实时数据流依赖真实 agentd，无浏览器/VM 环境下未实测渲染效果。
 */
import { useEffect, useState } from "react";

import {
  CMP_METHODS,
  systemInfoResultSchema,
  systemMetricsResultSchema,
  type SystemInfoResult,
} from "@cloud-machine/client-contracts";

import { formatBytes } from "../lib/fs-utils";
import {
  createMetricsPoller,
  formatByteRate,
  formatPercent,
  formatUptime,
  isMetricsConnectionError,
  METRICS_POLL_INTERVAL_MS,
  normalizeNetworkSeries,
  sparklinePoints,
} from "../lib/metrics";
import { useMachineRpc } from "../lib/use-machine-rpc";
import { machineMetricsCache } from "../lib/machine-metrics-cache";
import { useMachineMetricsCache } from "../lib/use-machine-metrics-cache";
import { userErrorMessage } from "../lib/user-error";

interface MetricsCardProps {
  machineId: string;
  running: boolean;
  visible: boolean;
  preparing?: boolean;
  loading?: boolean;
}

export function MetricsCard(props: MetricsCardProps) {
  const cache = useMachineMetricsCache(props.machineId);
  const { accountId } = cache;
  const { machineId, running, loading } = props;
  useEffect(() => {
    if (!running && !loading) machineMetricsCache.invalidate(accountId, machineId);
  }, [accountId, machineId, running, loading]);
  // Reset local polling too; an old read must not survive a new session or boot.
  return <MetricsCardSession key={cache.snapshot.generation} {...props} {...cache} />;
}

function MetricsCardSession({
  machineId,
  running,
  visible,
  preparing = false,
  loading = false,
  accountId,
  snapshot,
  recent,
}: MetricsCardProps & ReturnType<typeof useMachineMetricsCache>) {
  const { rpc, connState, connect } = useMachineRpc(
    machineId,
    snapshot.generation !== 0 && running && !loading,
  );
  const [hasSampled, setHasSampled] = useState(false);
  const [pollError, setPollError] = useState<{
    waiting: boolean;
    message: string;
  } | null>(null);

  // 连接成功后重新验证主机信息；已有缓存持续显示，刷新失败也不清空。
  useEffect(() => {
    if (connState !== "connected") return;
    let cancelled = false;
    const read = machineMetricsCache.begin(accountId, machineId);
    rpc
      .call(CMP_METHODS.SYSTEM_INFO)
      .then((result) => {
        if (!cancelled)
          machineMetricsCache.completeInfo(read, systemInfoResultSchema.parse(result));
      })
      .catch(() => {
        // info 展示为增强项，失败静默（metrics 轮询会单独报错）。
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, machineId, connState, rpc]);

  // 每秒读取 agentd 连续采样缓存；概览/页面隐藏时暂停，恢复后立即补一帧。
  useEffect(() => {
    if (connState !== "connected" || !running || !visible || loading) return;
    const poller = createMetricsPoller({
      isVisible: () => document.visibilityState === "visible",
      poll: async () => {
        const read = machineMetricsCache.begin(accountId, machineId);
        const sample = systemMetricsResultSchema.parse(await rpc.call(CMP_METHODS.SYSTEM_METRICS));
        return { read, sample };
      },
      onSample: ({ read, sample }) => {
        const result = machineMetricsCache.complete(read, sample);
        if (!result) return;
        setPollError(null);
        setHasSampled(true);
      },
      onError: (error) =>
        setPollError({
          waiting: isMetricsConnectionError(error),
          message: userErrorMessage(error, "指标拉取失败"),
        }),
    });
    void poller.tick();
    const timer = setInterval(() => void poller.tick(), METRICS_POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void poller.tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      poller.stop();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      setPollError(null);
    };
  }, [accountId, machineId, connState, rpc, running, visible, loading]);

  const latestRecord = recent ?? (hasSampled ? snapshot.latest : null);
  const latest = latestRecord?.sample ?? null;
  const footer = (
    <SystemInfoFooter info={snapshot.info?.value ?? null} uptimeSeconds={latest?.uptimeSeconds} />
  );
  if (loading && !latest) {
    return (
      <CardShell title="运行指标">
        <MetricsSkeleton animate={false} />
        {footer}
      </CardShell>
    );
  }

  if (!running && !loading) {
    return (
      <CardShell title="运行指标">
        <p className="text-xs text-zinc-500" role={preparing ? "status" : undefined}>
          {preparing
            ? "电脑正在启动或恢复，运行指标稍后自动更新"
            : "电脑未运行，启动后可查看实时指标"}
        </p>
      </CardShell>
    );
  }

  if (connState !== "connected" && !latest) {
    return (
      <CardShell title="运行指标">
        {connState === "idle" || connState === "connecting" ? (
          <span className="sr-only">正在连接电脑…</span>
        ) : (
          <div className="mb-3 flex items-center gap-3 text-xs text-zinc-500">
            <span>暂未连接到电脑</span>
            <button type="button" onClick={() => void connect()} className="cm-button">
              重新连接
            </button>
          </div>
        )}
        <MetricsSkeleton />
        {footer}
      </CardShell>
    );
  }

  // Both consumers contribute to the bounded, timestamped history, including while this
  // panel is unmounted. A stale cache alone must not render as a live first frame.
  const records = latest ? snapshot.history : [];
  const history = records.map((s) => s.sample);
  const timestamps = records.map((s) => s.receivedAt);
  const cpuSeries = history.map((s) => s.cpuUsage);
  const memSeries = history.map((s) =>
    s.memoryTotalBytes > 0 ? s.memoryUsedBytes / s.memoryTotalBytes : 0,
  );
  const diskSeries = history.map((s) =>
    s.diskTotalBytes > 0 ? s.diskUsedBytes / s.diskTotalBytes : 0,
  );
  const networkSeries = normalizeNetworkSeries(
    history.map((s) => s.networkReceiveBytesPerSecond),
    history.map((s) => s.networkTransmitBytesPerSecond),
  );
  // Keep the initial cache refresh silent, including the normal connection handshake.
  const updating =
    latest &&
    (loading || !hasSampled || !recent) &&
    !pollError &&
    (loading || connState === "idle" || connState === "connecting" || connState === "connected");

  return (
    <CardShell title="运行指标">
      {!loading && !updating && connState !== "connected" && (
        <div className="mb-2 flex items-center gap-2 rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-500">
          <span>电脑暂未连接，当前显示上次的运行指标</span>
          <button type="button" onClick={() => void connect()} className="cm-button ml-auto">
            重新连接
          </button>
        </div>
      )}
      {pollError &&
        connState === "connected" &&
        (pollError.waiting ? (
          <p role="status" className="mb-2 text-xs text-zinc-500">
            等待电脑通信就绪，运行指标将自动更新
            {latest ? "（当前显示上次采样数据）" : ""}
          </p>
        ) : (
          <p className="mb-2 rounded border px-2 py-1 text-xs cm-banner-warning">
            最近一次采样失败：{pollError.message}
          </p>
        ))}
      {!latest ? (
        <>
          <span className="sr-only">等待首次采样…</span>
          <MetricsSkeleton />
        </>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricGauge
            label="CPU"
            value={formatPercent(latest.cpuUsage)}
            ratio={latest.cpuUsage}
            series={cpuSeries}
            timestamps={timestamps}
          />
          <MetricGauge
            label="内存"
            value={`${formatBytes(latest.memoryUsedBytes)} / ${formatBytes(latest.memoryTotalBytes)}`}
            ratio={
              latest.memoryTotalBytes > 0 ? latest.memoryUsedBytes / latest.memoryTotalBytes : 0
            }
            series={memSeries}
            timestamps={timestamps}
          />
          <MetricGauge
            label="硬盘"
            value={
              latest.diskTotalBytes > 0
                ? `${formatBytes(latest.diskUsedBytes)} / ${formatBytes(latest.diskTotalBytes)}`
                : "暂不可用"
            }
            ratio={latest.diskTotalBytes > 0 ? latest.diskUsedBytes / latest.diskTotalBytes : 0}
            series={diskSeries}
            timestamps={timestamps}
            numericValue={latest.diskTotalBytes > 0}
          />
          <NetworkMetric
            receiveBytesPerSecond={latest.networkReceiveBytesPerSecond}
            transmitBytesPerSecond={latest.networkTransmitBytesPerSecond}
            receiveSeries={networkSeries.receive}
            transmitSeries={networkSeries.transmit}
            timestamps={timestamps}
          />
        </div>
      )}
      {footer}
    </CardShell>
  );
}

function CardShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="cm-panel p-3">
      <h2 className="text-xs font-medium tracking-wide text-zinc-500 uppercase">{title}</h2>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function SystemInfoFooter({
  info,
  uptimeSeconds,
}: {
  info: SystemInfoResult | null;
  uptimeSeconds?: number;
}) {
  const groups = [
    [
      ["主机标识", info?.hostname],
      ["内核", info?.kernel],
    ],
    [
      ["守护进程", info?.agentVersion],
      ["运行时长", uptimeSeconds === undefined ? undefined : formatUptime(uptimeSeconds)],
    ],
  ] as const;
  return (
    <div
      role="group"
      aria-label="电脑系统信息"
      className="mt-3 flex flex-col gap-x-3 gap-y-1 text-xs text-zinc-500 xl:flex-row"
    >
      {groups.map((fields) => (
        <div key={fields[0][0]} className="flex min-w-0 flex-col gap-x-3 gap-y-1 sm:flex-row">
          {fields.map(([label, value]) => (
            <span
              key={label}
              className="h-4 min-w-0 truncate leading-4 tabular-nums"
              title={value ? `${label}：${value}` : undefined}
            >
              {label}：{value ?? "—"}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function MetricsSkeleton({ animate = true }: { animate?: boolean }) {
  return (
    <div aria-hidden="true" className={animate ? "motion-safe:animate-pulse" : undefined}>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {["CPU", "内存", "硬盘", "网络"].map((label) => (
          <div key={label}>
            <div className="flex h-5 items-center justify-between gap-2">
              <span className="text-xs text-zinc-500">{label}</span>
              <span className="h-3 w-16 rounded bg-zinc-800" />
            </div>
            <div className="mt-1.5 h-1.5 rounded bg-zinc-800" />
            <div className="mt-2 h-7 rounded bg-zinc-800/45" />
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricGauge({
  label,
  value,
  ratio,
  series,
  timestamps,
  numericValue = true,
}: {
  label: string;
  value: string;
  ratio: number;
  series: number[];
  timestamps: number[];
  numericValue?: boolean;
}) {
  const clamped = Math.min(1, Math.max(0, ratio));
  const points = sparklinePoints(series, 120, 28, timestamps);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-zinc-500">{label}</span>
        <span
          className={
            numericValue
              ? "font-mono text-sm font-medium text-zinc-200 tabular-nums"
              : "font-sans text-xs font-normal text-zinc-500"
          }
        >
          {value}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-zinc-800">
        <div
          className={`h-full rounded ${clamped > 0.85 ? "bg-red-500" : "bg-emerald-500"}`}
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
      <div className="mt-2 h-7">
        {points && (
          <svg
            aria-label={`${label}趋势`}
            role="img"
            viewBox="0 0 120 28"
            preserveAspectRatio="none"
            className="h-full w-full text-emerald-500/70"
          >
            <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        )}
      </div>
    </div>
  );
}

function NetworkMetric({
  receiveBytesPerSecond,
  transmitBytesPerSecond,
  receiveSeries,
  transmitSeries,
  timestamps,
}: {
  receiveBytesPerSecond: number;
  transmitBytesPerSecond: number;
  receiveSeries: number[];
  transmitSeries: number[];
  timestamps: number[];
}) {
  const receivePoints = sparklinePoints(receiveSeries, 120, 28, timestamps);
  const transmitPoints = sparklinePoints(transmitSeries, 120, 28, timestamps);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-zinc-500">网络</span>
        <span className="flex flex-wrap justify-end gap-x-2 font-mono text-xs font-medium tabular-nums">
          <span
            aria-label={`接收 ${formatByteRate(receiveBytesPerSecond)}`}
            className="text-emerald-400"
          >
            ↓ {formatByteRate(receiveBytesPerSecond)}
          </span>
          <span
            aria-label={`发送 ${formatByteRate(transmitBytesPerSecond)}`}
            className="text-sky-400"
          >
            ↑ {formatByteRate(transmitBytesPerSecond)}
          </span>
        </span>
      </div>
      <div className="mt-5 h-7">
        {(receivePoints || transmitPoints) && (
          <svg
            aria-label="网络接收与发送速率趋势"
            role="img"
            viewBox="0 0 120 28"
            preserveAspectRatio="none"
            className="h-full w-full"
          >
            <polyline
              data-network-series="receive"
              points={receivePoints}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-emerald-500/75"
            />
            <polyline
              data-network-series="transmit"
              points={transmitPoints}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-sky-400/75"
            />
          </svg>
        )}
      </div>
    </div>
  );
}
