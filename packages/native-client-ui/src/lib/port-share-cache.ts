import type { MachinePortShare } from "@cloud-machine/api-client";
import type { QueryClient } from "@tanstack/react-query";

export const machinePortSharesQueryKey = (machineId: string) =>
  ["machine-port-shares", machineId] as const;

/**
 * Apply a share mutation without allowing an older in-flight list response to overwrite it.
 * The immediate cache update keeps the UI responsive; the invalidation then reconciles with
 * the server's canonical list.
 */
export async function updateMachinePortSharesCache(
  queryClient: QueryClient,
  machineId: string,
  update: (current: MachinePortShare[]) => MachinePortShare[],
): Promise<void> {
  const queryKey = machinePortSharesQueryKey(machineId);
  await queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData<MachinePortShare[]>(queryKey, (current) => update(current ?? []));
  void queryClient.invalidateQueries({ queryKey, exact: true });
}
