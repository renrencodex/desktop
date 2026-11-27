import type { Machine } from "@cloud-machine/api-client";

export interface MachineListPartition {
  visibleMachines: Machine[];
  deletingMachines: Machine[];
}

/** `deleting` remains in the API/cache for quota truth, but is not a normal navigable resource. */
export function partitionMachineList(machines: readonly Machine[]): MachineListPartition {
  const visibleMachines: Machine[] = [];
  const deletingMachines: Machine[] = [];
  for (const machine of machines) {
    if (machine.lifecycleStatus === "deleting") deletingMachines.push(machine);
    else visibleMachines.push(machine);
  }
  return { visibleMachines, deletingMachines };
}

/** Apply the DELETE 202 response without seeding a partial list when no list cache exists. */
export function applyAcceptedMachineDeletion(
  current: Machine[] | undefined,
  accepted: Machine,
): Machine[] | undefined {
  if (!current) return current;
  let replaced = false;
  const next = current.map((machine) => {
    if (machine.id !== accepted.id) return machine;
    replaced = true;
    return accepted;
  });
  return replaced ? next : current;
}
