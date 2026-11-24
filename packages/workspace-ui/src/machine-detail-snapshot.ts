import type { Machine } from "@cloud-machine/api-client";

/**
 * Merge a machine-list snapshot into the detail cache without regressing newer detail state.
 * A transitional list row must not create a detail entry by itself because list refreshes can
 * arrive after provisioning has already reported ready.
 */
export function mergeMachineDetailSnapshot(
  current: Machine | undefined,
  candidate: Machine,
): Machine | undefined {
  if (!current) return candidate.readyAt === null ? undefined : candidate;

  const currentUpdatedAt = Date.parse(current.updatedAt);
  const candidateUpdatedAt = Date.parse(candidate.updatedAt);
  if (!Number.isFinite(candidateUpdatedAt)) return current;
  if (!Number.isFinite(currentUpdatedAt) || candidateUpdatedAt > currentUpdatedAt) return candidate;
  return current;
}
