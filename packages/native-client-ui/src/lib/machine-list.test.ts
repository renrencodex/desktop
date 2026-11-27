import type { Machine } from "@cloud-machine/api-client";
import { expect, test } from "bun:test";

import { applyAcceptedMachineDeletion, partitionMachineList } from "./machine-list";

function machine(id: string, lifecycleStatus: Machine["lifecycleStatus"]): Machine {
  return {
    id,
    name: id,
    slug: id,
    region: "test",
    cluster: "cluster",
    clusterGroup: null,
    imageId: "image",
    planId: "plan",
    cpu: 2,
    memoryMb: 4096,
    diskGb: 40,
    gpuType: null,
    gpuCount: 0,
    egressLineId: "kr",
    egressLineAppliedId: "kr",
    lifecycleStatus,
    powerState: "off",
    agentConnectionState: "disconnected",
    readyAt: null,
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:00:00.000Z",
  };
}

test("deleting machines stay in the raw cache but leave the normal resource list", () => {
  const running = machine("running", "running");
  const deleting = machine("deleting", "deleting");
  expect(partitionMachineList([running, deleting])).toEqual({
    visibleMachines: [running],
    deletingMachines: [deleting],
  });
});

test("DELETE acceptance replaces only an existing cached machine", () => {
  const current = [machine("target", "stopped"), machine("other", "running")];
  const accepted = { ...current[0]!, lifecycleStatus: "deleting" as const };
  const next = applyAcceptedMachineDeletion(current, accepted);
  expect(next).toEqual([accepted, current[1]!]);
  expect(current[0]?.lifecycleStatus).toBe("stopped");

  expect(applyAcceptedMachineDeletion(undefined, accepted)).toBeUndefined();
  expect(applyAcceptedMachineDeletion(current, machine("missing", "deleting"))).toBe(current);
});
