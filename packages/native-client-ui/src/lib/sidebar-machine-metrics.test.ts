import { expect, test } from "bun:test";
import { systemMetricsResultSchema } from "@cloud-machine/client-contracts";

import { createMetricsPoller } from "./metrics";
import { machineUsage, SIDEBAR_METRICS_INTERVAL_MS } from "./sidebar-machine-metrics";

const sample = systemMetricsResultSchema.parse({
  cpuUsage: 0.25,
  loadAvg: [0, 0, 0],
  memoryUsedBytes: 1024,
  memoryTotalBytes: 4096,
  diskUsedBytes: 2048,
  diskTotalBytes: 8192,
  networkReceiveBytesPerSecond: 0,
  networkTransmitBytesPerSecond: 0,
  uptimeSeconds: 0,
});

test("Desktop 侧栏资源指标保留真实零值和网络速率", () => {
  expect(SIDEBAR_METRICS_INTERVAL_MS).toBe(3000);
  expect(machineUsage(sample)).toEqual({
    cpu: 0.25,
    memory: 0.25,
    networkReceiveBytesPerSecond: 0,
    networkTransmitBytesPerSecond: 0,
  });
  expect(machineUsage({ ...sample, memoryTotalBytes: 0 }).memory).toBeNull();
  expect(machineUsage({ ...sample, memoryUsedBytes: 8192 }).memory).toBe(1);
  expect(
    machineUsage({
      ...sample,
      networkReceiveBytesPerSecond: 1_572_864,
      networkTransmitBytesPerSecond: 262_144,
    }),
  ).toMatchObject({
    networkReceiveBytesPerSecond: 1_572_864,
    networkTransmitBytesPerSecond: 262_144,
  });
});

test("Desktop 各电脑的轮询独立，隐藏和停止时不采集，停止后的旧回复被丢弃", async () => {
  let visible = true;
  let calls = 0;
  let resolve!: (value: typeof sample) => void;
  const received: unknown[] = [];
  const first = createMetricsPoller({
    isVisible: () => visible,
    poll: () => {
      calls++;
      return new Promise<typeof sample>((finish) => {
        resolve = finish;
      });
    },
    onSample: (value) => received.push(value),
    onError: () => {},
  });
  const pending = first.tick();
  await first.tick();
  expect(calls).toBe(1);
  const second = createMetricsPoller({
    isVisible: () => visible,
    poll: async () => ({ ...sample, cpuUsage: 0.75 }),
    onSample: (value) => received.push(value.cpuUsage),
    onError: () => {},
  });
  await second.tick();
  expect(received).toEqual([0.75]);
  first.stop();
  resolve(sample);
  await pending;
  expect(received).toEqual([0.75]);
  visible = false;
  await second.tick();
  expect(received).toEqual([0.75]);
  second.stop();
});
