import type { SystemMetricsResult } from "@cloud-machine/client-contracts";

export const SIDEBAR_METRICS_INTERVAL_MS = 3000;

export interface MachineUsage {
  cpu: number;
  memory: number | null;
  networkReceiveBytesPerSecond: number;
  networkTransmitBytesPerSecond: number;
}

export function machineUsage(sample: SystemMetricsResult): MachineUsage {
  return {
    cpu: Math.min(1, Math.max(0, sample.cpuUsage)),
    memory:
      sample.memoryTotalBytes > 0
        ? Math.min(1, Math.max(0, sample.memoryUsedBytes / sample.memoryTotalBytes))
        : null,
    networkReceiveBytesPerSecond: sample.networkReceiveBytesPerSecond,
    networkTransmitBytesPerSecond: sample.networkTransmitBytesPerSecond,
  };
}
