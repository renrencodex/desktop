import type { SystemInfoResult, SystemMetricsResult } from "@cloud-machine/client-contracts";

export const MACHINE_METRICS_CACHE_TTL_MS = 10_000;
export const MAX_MACHINE_METRICS_SAMPLES = 150;
export const MACHINE_METRICS_HISTORY_WINDOW_MS = 150_000;
const HISTORY_BUCKET_MS = 1000;

export interface CachedMachineMetrics {
  readonly sample: SystemMetricsResult;
  readonly receivedAt: number;
  readonly sequence: number;
}

export interface CachedMachineInfo {
  readonly value: SystemInfoResult;
  readonly receivedAt: number;
  readonly sequence: number;
}

export interface MachineMetricsSnapshot {
  /** Changes on account/session reset, machine invalidation or confirmed reboot, not every sample. */
  readonly generation: number;
  readonly latest: CachedMachineMetrics | null;
  readonly history: readonly CachedMachineMetrics[];
  /** Low-frequency metadata, revalidated on connection and cleared with the machine session. */
  readonly info: CachedMachineInfo | null;
}

export interface MetricsRead {
  readonly accountId: string;
  readonly machineId: string;
  readonly generation: number;
  readonly sequence: number;
  /** Latest accepted sample when this request began; a causal marker independent of wall time. */
  readonly baselineSequence: number | null;
}

const EMPTY: MachineMetricsSnapshot = { generation: 0, latest: null, history: [], info: null };

function appendHistory(
  current: MachineMetricsSnapshot,
  latest: CachedMachineMetrics,
): readonly CachedMachineMetrics[] {
  const previous = current.latest;
  // Boot changes are handled in complete(); do not join gaps or a wall-clock rollback either.
  if (
    !previous ||
    latest.receivedAt < previous.receivedAt ||
    latest.receivedAt - previous.receivedAt >= MACHINE_METRICS_CACHE_TTL_MS
  ) {
    return [latest];
  }
  const history = current.history.filter(
    (point) => latest.receivedAt - point.receivedAt < MACHINE_METRICS_HISTORY_WINDOW_MS,
  );
  const tail = history.at(-1);
  // Sidebar and panel have independent pollers. Coalesce their points within one second
  // while still updating the latest reading on every successful response.
  if (
    tail &&
    Math.floor(tail.receivedAt / HISTORY_BUCKET_MS) ===
      Math.floor(latest.receivedAt / HISTORY_BUCKET_MS)
  ) {
    history[history.length - 1] = latest;
  } else {
    history.push(latest);
  }
  return history.slice(-MAX_MACHINE_METRICS_SAMPLES);
}

/** Session-local, platform-independent cache. It owns no connections or polling timers. */
export function createMachineMetricsCache(now: () => number = () => Date.now()) {
  let account: string | null = null;
  let generation = 0;
  let sequence = 0;
  const machines = new Map<string, MachineMetricsSnapshot>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const snapshot = (accountId: string | null, machineId: string): MachineMetricsSnapshot => {
    if (!accountId || accountId !== account) return EMPTY;
    let current = machines.get(machineId);
    if (!current) {
      current = { generation: ++generation, latest: null, history: [], info: null };
      machines.set(machineId, current);
    }
    return current;
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setAccount(accountId: string | null) {
      if (accountId === account) return;
      account = accountId;
      machines.clear();
      notify();
    },
    snapshot,
    recent(value: MachineMetricsSnapshot): CachedMachineMetrics | null {
      const latest = value.latest;
      if (!latest) return null;
      const age = now() - latest.receivedAt;
      return age >= 0 && age < MACHINE_METRICS_CACHE_TTL_MS ? latest : null;
    },
    begin(accountId: string | null, machineId: string): MetricsRead | null {
      const current = snapshot(accountId, machineId);
      return current === EMPTY
        ? null
        : {
            accountId: accountId!,
            machineId,
            generation: current.generation,
            sequence: ++sequence,
            baselineSequence: current.latest?.sequence ?? null,
          };
    },
    complete(read: MetricsRead | null, sample: SystemMetricsResult): CachedMachineMetrics | null {
      if (!read || read.accountId !== account) return null;
      const current = machines.get(read.machineId);
      if (!current || current.generation !== read.generation) return null;
      // An older request may finish after a newer poll from the other consumer.
      if (current.latest && current.latest.sequence > read.sequence) return current.latest;
      if (current.latest?.sequence === read.sequence) return current.latest;
      const rebooted =
        current.latest !== null && sample.uptimeSeconds < current.latest.sample.uptimeSeconds;
      // Independent RPCs can reach the agent and return in a different order. A smaller
      // uptime from an overlapping request is ambiguous, not proof of a new boot. Keep the
      // snapshot/TTL untouched until a read begun after that snapshot confirms the rollback.
      if (rebooted && read.baselineSequence !== current.latest!.sequence) return current.latest;
      const latest = { sample, receivedAt: now(), sequence: read.sequence };
      machines.set(read.machineId, {
        // Fence every pre-confirmation read, including those with larger request sequences,
        // so an old boot cannot be reintroduced after the new curve has started.
        generation: rebooted ? ++generation : current.generation,
        latest,
        history: rebooted ? [latest] : appendHistory(current, latest),
        info: rebooted ? null : current.info,
      });
      notify();
      return latest;
    },
    completeInfo(read: MetricsRead | null, value: SystemInfoResult): CachedMachineInfo | null {
      if (!read || read.accountId !== account) return null;
      const current = machines.get(read.machineId);
      if (!current || current.generation !== read.generation) return null;
      // Metadata has its own response order; a metrics poll must not supersede an info read.
      if (current.info && current.info.sequence >= read.sequence) return current.info;
      const info = { value, receivedAt: now(), sequence: read.sequence };
      machines.set(read.machineId, { ...current, info });
      notify();
      return info;
    },
    invalidate(accountId: string | null, machineId: string) {
      if (!accountId || accountId !== account) return;
      machines.set(machineId, { generation: ++generation, latest: null, history: [], info: null });
      notify();
    },
  };
}
