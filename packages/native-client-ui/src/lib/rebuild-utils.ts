/**
 * Rebuild 纯逻辑（设计文档 22 节 Rebuild）。
 */
import type { Machine } from "@cloud-machine/api-client";

/** Rebuild 可用状态（与后端一致：running / stopped / error）。 */
export function canRebuild(lifecycle: Machine["lifecycleStatus"]): boolean {
  return lifecycle === "running" || lifecycle === "stopped" || lifecycle === "error";
}
