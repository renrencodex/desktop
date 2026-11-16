import { z } from "zod";

/** 机器创建/重建的可观测阶段；百分比由 Worker 按真实里程碑推进。 */
export const machineProvisionStageSchema = z.enum([
  "queued",
  "tenant_resources",
  "instance",
  "boot",
  "agent",
  "workspace",
  "ready",
]);

/** 初始化失败后客户端可以安全展示的下一步；不得由客户端自行推断账务状态。 */
export const machineProvisionRecoveryActionSchema = z.enum([
  "retry",
  "renew",
  "refund_pending",
  "repurchase",
  "unavailable",
]);

export const machineProvisionProgressSchema = z.object({
  stage: machineProvisionStageSchema,
  percent: z.number().int().min(0).max(100),
  /** 可安全展示给终端用户的稳定错误码；详细基础设施错误只进服务端日志。 */
  failureCode: z.string().trim().min(1).max(100).optional(),
});

export type MachineProvisionStage = z.infer<typeof machineProvisionStageSchema>;
export type MachineProvisionRecoveryAction = z.infer<typeof machineProvisionRecoveryActionSchema>;
export type MachineProvisionProgress = z.infer<typeof machineProvisionProgressSchema>;
