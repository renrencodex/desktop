/**
 * Snapshots 面板纯函数（设计文档 Snapshot 章节；Phase 6 切片 2）。
 */
import type { Machine, MachineSnapshot } from "@cloud-machine/api-client";

/** 是否允许创建备份（与后端一致：running / stopped）。 */
export function canCreateSnapshot(lifecycle: Machine["lifecycleStatus"]): boolean {
  return lifecycle === "running" || lifecycle === "stopped";
}

/**
 * Restore 不可用的原因（null = 可用）：
 * 备份须 available，且电脑须 stopped（恢复要求先停止电脑）。
 */
export function restoreBlockReason(
  lifecycle: Machine["lifecycleStatus"],
  snapshotStatus: MachineSnapshot["status"],
): string | null {
  if (snapshotStatus !== "available") return "备份尚未就绪，无法恢复";
  if (lifecycle !== "stopped") return "需先停止电脑才能恢复";
  return null;
}
