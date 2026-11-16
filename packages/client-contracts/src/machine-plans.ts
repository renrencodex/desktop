export interface MachinePlanIdentity {
  code: string;
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
}

const BUILT_IN_PLAN_LABELS: Readonly<Record<string, string>> = {
  Base: "基础版",
  Standard: "标准版",
  Pro: "专业版",
  "Dev Nano": "基础版",
  "Dev Base": "基础版",
  "Dev Standard": "标准版",
  "Dev Pro": "专业版",
  // 兼容改名前写入订单快照和客户端缓存的中文展示值。
  高级版: "专业版",
  "High Memory": "高内存型",
  "GPU 4090": "GPU 4090 型",
  "GPU 5090": "GPU 5090 型",
};

const NANO_SPEC = { cpu: 2, memoryMb: 2048, diskGb: 50 } as const;

/**
 * Returns the user-facing name for a built-in machine plan.
 *
 * A name-only legacy `Nano` is the former 4 CPU base plan. The new entry plan
 * is identified by its complete 2 CPU / 2 GiB / 50 GiB specification so that
 * API and client releases can safely straddle the catalog data migration.
 */
export function machinePlanDisplayName(plan: string | MachinePlanIdentity): string {
  const code = typeof plan === "string" ? plan : plan.code;
  if (code === "Nano") {
    return typeof plan !== "string" &&
      plan.cpu === NANO_SPEC.cpu &&
      plan.memoryMb === NANO_SPEC.memoryMb &&
      plan.diskGb === NANO_SPEC.diskGb
      ? "入门版"
      : "基础版";
  }
  return BUILT_IN_PLAN_LABELS[code] ?? code;
}
