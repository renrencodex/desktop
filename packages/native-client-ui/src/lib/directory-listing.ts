import type { FsEntry } from "@cloud-machine/client-contracts";
import { listDir } from "./fs-client";
import type { MachineRpcClient } from "./machine-rpc";

type ListingResult = { ok: true; entries: FsEntry[] } | { ok: false; error: unknown };
interface Listener {
  isActive(): boolean;
  complete(result: ListingResult): void;
}
interface PendingListing {
  listeners: Set<Listener>;
  refreshRequested: boolean;
}

// Keep in-flight ownership across effects, panel switches and component remounts.
// No completed directory contents are cached here.
const pendingListings = new WeakMap<MachineRpcClient, Map<string, PendingListing>>();

export function requestDirectoryListing(rpc: MachineRpcClient, path: string, listener: Listener) {
  let paths = pendingListings.get(rpc);
  if (!paths) {
    paths = new Map();
    pendingListings.set(rpc, paths);
  }
  let pending = paths.get(path);
  const existing = Boolean(pending);
  if (!pending) {
    pending = { listeners: new Set(), refreshRequested: false };
    paths.set(path, pending);
  } else {
    // A newly visible view/refresh may need changes made since this read began.
    pending.refreshRequested = true;
  }
  pending.listeners.add(listener);
  if (!existing) void load(rpc, path, paths, pending);
  return {
    refresh() {
      pending.refreshRequested = true;
    },
    cancel() {
      pending.listeners.delete(listener);
    },
  };
}

async function load(
  rpc: MachineRpcClient,
  path: string,
  paths: Map<string, PendingListing>,
  pending: PendingListing,
): Promise<void> {
  for (;;) {
    pending.refreshRequested = false;
    let result: ListingResult;
    try {
      result = { ok: true, entries: await listDir(rpc, path) };
    } catch (error) {
      result = { ok: false, error };
    }
    if (pending.refreshRequested && [...pending.listeners].some((item) => item.isActive()))
      continue; // Any number of invalidations coalesce into one subsequent read.
    paths.delete(path);
    const listeners = [...pending.listeners];
    pending.listeners.clear();
    for (const listener of listeners) listener.complete(result);
    return;
  }
}
