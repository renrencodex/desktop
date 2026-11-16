"use client";

import type { Machine } from "@cloud-machine/api-client";
import {
  CMP_METHODS,
  isMachineRuntimeAvailable,
  systemMetricsResultSchema,
} from "@cloud-machine/client-contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { createMetricsPoller, formatByteRate, formatPercent } from "../lib/metrics";
import type { MachineRpcClient } from "../lib/machine-rpc";
import { useOnlineStatus } from "../lib/responsive";
import {
  machineUsage,
  SIDEBAR_METRICS_INTERVAL_MS,
  type MachineUsage,
} from "../lib/sidebar-machine-metrics";
import { useMachineRpc } from "../lib/use-machine-rpc";
import { machineMetricsCache } from "../lib/machine-metrics-cache";
import { useMachineMetricsCache } from "../lib/use-machine-metrics-cache";

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
const pageVisible = () => document.visibilityState === "visible";
const serverVisible = () => false;

export function SidebarMachineMetrics({ machine, active }: { machine: Machine; active: boolean }) {
  const elementRef = useRef<HTMLDivElement>(null);
  const [intersecting, setIntersecting] = useState(
    () => typeof window !== "undefined" && typeof IntersectionObserver === "undefined",
  );
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible, serverVisible);
  const online = useOnlineStatus();
  const running = machine.readyAt !== null && isMachineRuntimeAvailable(machine);
  const { accountId, snapshot } = useMachineMetricsCache(machine.id);
  useEffect(() => {
    if (!running) machineMetricsCache.invalidate(accountId, machine.id);
  }, [accountId, machine.id, running]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    // IntersectionObserver also respects clipping by the sidebar's scroll container.
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setIntersecting(entry?.isIntersecting === true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const collecting =
    active && visible && intersecting && online && running && snapshot.generation !== 0;
  return (
    <div ref={elementRef} data-machine-usage={machine.id}>
      {collecting ? (
        <LiveMachineUsage key={snapshot.generation} machineId={machine.id} accountId={accountId} />
      ) : (
        <SidebarMachineUsage unavailable={!running ? "未运行" : !online ? "暂无数据" : undefined} />
      )}
    </div>
  );
}

function LiveMachineUsage({
  machineId,
  accountId,
}: {
  machineId: string;
  accountId: string | null;
}) {
  const { rpc, connState } = useMachineRpc(machineId, true);
  if (connState !== "connected") {
    return (
      <SidebarMachineUsage
        unavailable={connState === "disconnected" || connState === "error" ? "暂无数据" : undefined}
      />
    );
  }
  return <ConnectedMachineUsage rpc={rpc} machineId={machineId} accountId={accountId} />;
}

function ConnectedMachineUsage({
  rpc,
  machineId,
  accountId,
}: {
  rpc: MachineRpcClient;
  machineId: string;
  accountId: string | null;
}) {
  const [usage, setUsage] = useState<MachineUsage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const poller = createMetricsPoller({
      isVisible: pageVisible,
      poll: async () => {
        const read = machineMetricsCache.begin(accountId, machineId);
        const sample = systemMetricsResultSchema.parse(await rpc.call(CMP_METHODS.SYSTEM_METRICS));
        return { read, sample };
      },
      onSample: ({ read, sample }) => {
        const result = machineMetricsCache.complete(read, sample);
        if (!result) return;
        setUsage(machineUsage(result.sample));
        setFailed(false);
      },
      onError: () => {
        setUsage(null);
        setFailed(true);
      },
    });
    void poller.tick();
    const timer = window.setInterval(() => void poller.tick(), SIDEBAR_METRICS_INTERVAL_MS);
    return () => {
      poller.stop();
      window.clearInterval(timer);
    };
  }, [rpc, machineId, accountId]);

  return <SidebarMachineUsage usage={usage} unavailable={failed ? "暂无数据" : undefined} />;
}

export function SidebarMachineUsage({
  usage,
  unavailable,
}: {
  usage?: MachineUsage | null;
  unavailable?: string;
}) {
  if (unavailable) {
    return <div className="flex h-10 items-center text-[10px] text-zinc-500">{unavailable}</div>;
  }
  const receiveRate =
    usage === null || usage === undefined
      ? null
      : formatByteRate(usage.networkReceiveBytesPerSecond);
  const transmitRate =
    usage === null || usage === undefined
      ? null
      : formatByteRate(usage.networkTransmitBytesPerSecond);
  return (
    <div className="grid gap-0.5">
      {(
        [
          ["CPU", usage?.cpu],
          ["内存", usage?.memory],
        ] as const
      ).map(([label, ratio]) => (
        <div
          key={label}
          className="grid h-3 grid-cols-[1.75rem_minmax(0,1fr)_1.75rem] items-center gap-1.5 text-[10px] leading-3 text-zinc-500"
        >
          <span>{label}</span>
          <span
            role="progressbar"
            aria-label={`${label}使用率`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={ratio == null ? undefined : Math.round(ratio * 100)}
            aria-valuetext={ratio == null ? "暂无数据" : formatPercent(ratio)}
            className="h-[3px] overflow-hidden rounded-full bg-zinc-800/60"
          >
            <span
              className="block h-full rounded-full bg-[var(--cm-accent)] motion-safe:transition-[width] motion-safe:duration-300"
              style={{ width: `${(ratio ?? 0) * 100}%` }}
            />
          </span>
          <span className="text-right tabular-nums">
            {ratio == null ? "--" : formatPercent(ratio)}
          </span>
        </div>
      ))}
      <div className="grid h-3 grid-cols-[1.375rem_minmax(0,1fr)] items-center gap-x-1 text-[10px] leading-3 text-zinc-500">
        <span>网络</span>
        <span className="flex min-w-0 items-center justify-start gap-1 overflow-hidden whitespace-nowrap font-mono text-[8px] tracking-[-0.02em] tabular-nums">
          <span data-network-rate="receive" className="min-w-0 overflow-hidden text-ellipsis">
            <span className="sr-only">接收 {receiveRate ?? "暂无数据"}</span>
            <span aria-hidden="true">
              <span className="text-emerald-400">↓</span>
              {receiveRate ?? "--"}
            </span>
          </span>
          <span
            data-network-rate="transmit"
            className="min-w-0 overflow-hidden text-ellipsis text-right"
          >
            <span className="sr-only">发送 {transmitRate ?? "暂无数据"}</span>
            <span aria-hidden="true">
              <span className="text-sky-400">↑</span>
              {transmitRate ?? "--"}
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}
