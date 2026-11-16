import { MACHINE_METRICS_CACHE_TTL_MS } from "@cloud-machine/workspace-ui/machine-metrics-cache";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { useAuthStore } from "../stores/auth";
import { machineMetricsCache } from "./machine-metrics-cache";

const serverSnapshot = () => machineMetricsCache.snapshot(null, "");

export function useMachineMetricsCache(machineId: string) {
  const accountId = useAuthStore((state) => state.user?.id ?? null);
  const getSnapshot = useCallback(
    () => machineMetricsCache.snapshot(accountId, machineId),
    [accountId, machineId],
  );
  const snapshot = useSyncExternalStore(machineMetricsCache.subscribe, getSnapshot, serverSnapshot);
  const [, rerender] = useState(0);
  // Expiry must also update a card whose first RPC is still pending.
  useEffect(() => {
    if (!snapshot.latest) return;
    const delay = snapshot.latest.receivedAt + MACHINE_METRICS_CACHE_TTL_MS - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => rerender((value) => value + 1), delay);
    return () => clearTimeout(timer);
  }, [snapshot]);
  return { accountId, snapshot, recent: machineMetricsCache.recent(snapshot) };
}
