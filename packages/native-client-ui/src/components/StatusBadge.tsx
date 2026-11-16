/** 状态徽章（58.2：状态用 dot/badge/短文本表达，不堆文字）。 */
import type { Machine } from "@cloud-machine/api-client";
import { LoaderCircle } from "lucide-react";

import { lifecycleLabel, powerLabel } from "../lib/display-labels";

const LIFECYCLE_STYLE: Record<Machine["lifecycleStatus"], { dot: string; label: string }> = {
  provisioning: { dot: "bg-amber-400 animate-pulse", label: lifecycleLabel("provisioning") },
  starting: { dot: "bg-amber-400 animate-pulse", label: lifecycleLabel("starting") },
  running: { dot: "bg-emerald-400", label: lifecycleLabel("running") },
  stopping: { dot: "bg-amber-400 animate-pulse", label: lifecycleLabel("stopping") },
  stopped: { dot: "bg-zinc-500", label: lifecycleLabel("stopped") },
  snapshotting: { dot: "bg-amber-400 animate-pulse", label: lifecycleLabel("snapshotting") },
  restoring: { dot: "bg-amber-400 animate-pulse", label: lifecycleLabel("restoring") },
  rebuilding: { dot: "bg-amber-400 animate-pulse", label: lifecycleLabel("rebuilding") },
  deleting: { dot: "bg-amber-400", label: lifecycleLabel("deleting") },
  deleted: { dot: "bg-zinc-600", label: lifecycleLabel("deleted") },
  error: { dot: "bg-red-500", label: lifecycleLabel("error") },
};

/** 固定图标槽，删除转圈与普通状态圆点切换时不挤动文字。 */
export function LifecycleIndicator({
  status,
  dotClassName,
}: {
  status: Machine["lifecycleStatus"];
  dotClassName?: string;
}) {
  return (
    <span
      data-machine-lifecycle={status}
      title={lifecycleLabel(status)}
      aria-hidden="true"
      className="inline-flex h-3 w-3 shrink-0 items-center justify-center"
    >
      {status === "deleting" ? (
        <LoaderCircle size={12} className="text-amber-400 motion-safe:animate-spin" />
      ) : (
        <span
          className={`h-1.5 w-1.5 rounded-full ${dotClassName ?? LIFECYCLE_STYLE[status].dot}`}
        />
      )}
    </span>
  );
}

export function LifecycleBadge({ status }: { status: Machine["lifecycleStatus"] }) {
  const s = LIFECYCLE_STYLE[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
      <LifecycleIndicator status={status} />
      {s.label}
    </span>
  );
}

export function PowerBadge({ power }: { power: Machine["powerState"] }) {
  const map = {
    on: { dot: "bg-emerald-400", label: powerLabel("on") },
    off: { dot: "bg-zinc-500", label: powerLabel("off") },
    unknown: { dot: "bg-zinc-600", label: powerLabel("unknown") },
  } as const;
  const s = map[power];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export function ConnectionBadge({ state }: { state: Machine["agentConnectionState"] }) {
  const map = {
    connected: { dot: "bg-emerald-400", label: "通信正常" },
    disconnected: { dot: "bg-red-500", label: "通信中断" },
    never_connected: { dot: "bg-zinc-600", label: "通信中断" },
  } as const;
  const s = map[state];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
