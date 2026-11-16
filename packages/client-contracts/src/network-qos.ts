import { z } from "zod";

export const DEFAULT_MACHINE_PUBLIC_BANDWIDTH_MBPS = 20;
export const MAX_MACHINE_PUBLIC_BANDWIDTH_MBPS = 100_000;

/** null 表示管理员显式关闭该租户的单机公网限速。 */
export const machinePublicBandwidthMbpsSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_MACHINE_PUBLIC_BANDWIDTH_MBPS)
  .nullable();

export type MachinePublicBandwidthMbps = z.infer<typeof machinePublicBandwidthMbpsSchema>;
