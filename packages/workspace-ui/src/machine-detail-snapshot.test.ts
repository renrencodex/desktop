import type { Machine } from "@cloud-machine/api-client";
import { expect, test } from "bun:test";

import { mergeMachineDetailSnapshot } from "./machine-detail-snapshot";

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "machine-1",
    name: "测试电脑",
    slug: "machine-1",
    region: "cn-test-1",
    cluster: "cluster-1",
    clusterGroup: null,
    imageId: "image-1",
    planId: "plan-1",
    cpu: 2,
    memoryMb: 4096,
    diskGb: 40,
    gpuType: null,
    gpuCount: 0,
    egressLineId: "default",
    egressLineAppliedId: "default",
    lifecycleStatus: "running",
    powerState: "on",
    agentConnectionState: "connected",
    readyAt: "2026-11-24T08:00:00.000Z",
    createdAt: "2026-11-24T07:58:00.000Z",
    updatedAt: "2026-11-24T08:00:00.000Z",
    ...overrides,
  };
}

test("transitional list rows do not create a machine detail cache entry", () => {
  const candidate = machine({
    lifecycleStatus: "provisioning",
    powerState: "unknown",
    agentConnectionState: "never_connected",
    readyAt: null,
  });

  expect(mergeMachineDetailSnapshot(undefined, candidate)).toBeUndefined();
});

test("ready list rows can warm an empty machine detail cache", () => {
  const candidate = machine();

  expect(mergeMachineDetailSnapshot(undefined, candidate)).toBe(candidate);
});

test("older or equal list rows cannot overwrite newer machine detail", () => {
  const current = machine({ updatedAt: "2026-11-24T08:00:05.000Z" });
  const older = machine({ updatedAt: "2026-11-24T08:00:04.000Z", readyAt: null });
  const equal = machine({ updatedAt: current.updatedAt, name: "旧名称" });

  expect(mergeMachineDetailSnapshot(current, older)).toBe(current);
  expect(mergeMachineDetailSnapshot(current, equal)).toBe(current);
});

test("a strictly newer lifecycle snapshot can move a ready machine back to transitional", () => {
  const current = machine();
  const rebuilding = machine({
    lifecycleStatus: "rebuilding",
    powerState: "unknown",
    agentConnectionState: "disconnected",
    readyAt: null,
    updatedAt: "2026-11-24T08:01:00.000Z",
  });

  expect(mergeMachineDetailSnapshot(current, rebuilding)).toBe(rebuilding);
});
