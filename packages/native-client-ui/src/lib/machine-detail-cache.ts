import type { Machine } from "@cloud-machine/api-client";

import { MACHINE_TITLE_ACCOUNT_KEY } from "./machine-title";

export const MACHINE_DETAIL_CACHE_KEY = "cloud-machine.machine-detail.v1";
const MAX_AGE_MS = 10 * 60 * 1000;

function isMachine(value: unknown): value is Machine {
  if (!value || typeof value !== "object") return false;
  const machine = value as Record<string, unknown>;
  return (
    [
      "id",
      "name",
      "slug",
      "region",
      "cluster",
      "imageId",
      "planId",
      "egressLineId",
      "egressLineAppliedId",
      "createdAt",
      "updatedAt",
    ].every((key) => typeof machine[key] === "string") &&
    ["cpu", "memoryMb", "diskGb", "gpuCount"].every(
      (key) => typeof machine[key] === "number" && Number.isFinite(machine[key]),
    ) &&
    (machine.clusterGroup === null || typeof machine.clusterGroup === "string") &&
    (machine.imageLabel == null || typeof machine.imageLabel === "string") &&
    (machine.gpuType === null || typeof machine.gpuType === "string") &&
    (machine.readyAt === null || typeof machine.readyAt === "string") &&
    [
      "provisioning",
      "starting",
      "running",
      "stopping",
      "stopped",
      "snapshotting",
      "restoring",
      "rebuilding",
      "deleting",
      "deleted",
      "error",
    ].includes(String(machine.lifecycleStatus)) &&
    ["unknown", "on", "off"].includes(String(machine.powerState)) &&
    ["never_connected", "connected", "disconnected"].includes(String(machine.agentConnectionState))
  );
}

export function readMachineDetailCache(
  accountId: string,
  machineId: string,
): { machine: Machine; planName: string | null } | null {
  if (typeof window === "undefined") return null;
  try {
    if (localStorage.getItem(MACHINE_TITLE_ACCOUNT_KEY) !== accountId) return null;
    const raw = sessionStorage.getItem(MACHINE_DETAIL_CACHE_KEY);
    if (!raw) return null;
    const cached: unknown = JSON.parse(raw);
    if (!cached || typeof cached !== "object") return null;
    const { accountId: owner, savedAt, machine, planName } = cached as Record<string, unknown>;
    if (
      owner !== accountId ||
      typeof savedAt !== "number" ||
      !Number.isFinite(savedAt) ||
      savedAt > Date.now() ||
      Date.now() - savedAt > MAX_AGE_MS ||
      !isMachine(machine) ||
      machine.id !== machineId
    )
      return null;
    return { machine, planName: typeof planName === "string" ? planName : null };
  } catch {
    return null;
  }
}

export function cacheMachineDetail(accountId: string, machine: Machine, planName?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (localStorage.getItem(MACHINE_TITLE_ACCOUNT_KEY) !== accountId) return;
    const previous = readMachineDetailCache(accountId, machine.id);
    sessionStorage.setItem(
      MACHINE_DETAIL_CACHE_KEY,
      JSON.stringify({
        accountId,
        savedAt: Date.now(),
        machine,
        planName: planName ?? previous?.planName ?? null,
      }),
    );
  } catch {
    // Storage is optional; the live API remains the source of truth.
  }
}

export function clearMachineDetailCache(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(MACHINE_DETAIL_CACHE_KEY);
  } catch {
    // Storage may be unavailable.
  }
}

export function syncMachineDetailCacheAccount(accountId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    const raw = sessionStorage.getItem(MACHINE_DETAIL_CACHE_KEY);
    if (!accountId || (raw && JSON.parse(raw)?.accountId !== accountId)) clearMachineDetailCache();
  } catch {
    clearMachineDetailCache();
  }
}
