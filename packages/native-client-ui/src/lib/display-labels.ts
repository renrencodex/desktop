import type { Machine, MachineLifecycleStatus } from "@cloud-machine/api-client";
import { machinePlanDisplayName, type MachinePlanIdentity } from "@cloud-machine/client-contracts";

const LIFECYCLE_LABELS: Record<MachineLifecycleStatus, string> = {
  provisioning: "创建中",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  stopped: "已停止",
  snapshotting: "备份创建中",
  restoring: "恢复中",
  rebuilding: "重建中",
  deleting: "删除中",
  deleted: "已删除",
  error: "异常",
};

const POWER_LABELS: Record<Machine["powerState"], string> = {
  on: "已开机",
  off: "已关机",
  unknown: "未知",
};

export function lifecycleLabel(status: MachineLifecycleStatus): string {
  return LIFECYCLE_LABELS[status];
}

export function powerLabel(state: Machine["powerState"]): string {
  return POWER_LABELS[state];
}

export function planLabel(
  name: string,
  identity?: Omit<MachinePlanIdentity, "code"> & { code?: string },
): string {
  return machinePlanDisplayName(identity ? { ...identity, code: identity.code ?? name } : name);
}

export function peakBandwidthLabel(value: number | null | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value === null ? "峰值网速不限速" : `峰值网速${value}Mbps`;
}

/** 本地区域不展示文案；其它区域原样返回。 */
export function regionLabel(name: string): string | undefined {
  if (!name || name === "local") return undefined;
  return name;
}
