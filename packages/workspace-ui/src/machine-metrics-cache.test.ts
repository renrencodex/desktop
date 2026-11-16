import { expect, test } from "bun:test";
import type { SystemInfoResult, SystemMetricsResult } from "@cloud-machine/client-contracts";

import {
  createMachineMetricsCache,
  MACHINE_METRICS_CACHE_TTL_MS,
  MACHINE_METRICS_HISTORY_WINDOW_MS,
  MAX_MACHINE_METRICS_SAMPLES,
} from "./machine-metrics-cache";

const sample = (cpuUsage = 0.25): SystemMetricsResult => ({
  cpuUsage,
  loadAvg: [0, 0, 0],
  memoryTotalBytes: 4096,
  memoryUsedBytes: 2048,
  diskTotalBytes: 40960,
  diskUsedBytes: 20480,
  networkReceiveBytesPerSecond: 1536,
  networkTransmitBytesPerSecond: 512,
  uptimeSeconds: 60,
});

const info = (agentVersion = "0.15.4", hostname = "vm-m1"): SystemInfoResult => ({
  hostname,
  kernel: "6.8.0-146-generic",
  agentVersion,
  os: "linux",
  arch: "x64",
  uptimeSeconds: 99999,
  cpuCount: 2,
  memoryTotalBytes: 4096,
});

test("only the active account can read or publish, and machines stay isolated", () => {
  const cache = createMachineMetricsCache();
  expect(cache.begin("a", "m1")).toBeNull();
  cache.setAccount("a");
  cache.complete(cache.begin("a", "m1"), sample());
  expect(cache.recent(cache.snapshot("a", "m1"))?.sample).toEqual(sample());
  expect(cache.snapshot("b", "m1").latest).toBeNull();
  expect(cache.snapshot("b", "m1").history).toEqual([]);
  expect(cache.snapshot("a", "m2").latest).toBeNull();
  expect(cache.snapshot("a", "m2").history).toEqual([]);
  expect(cache.begin(null, "m1")).toBeNull();
  expect(cache.begin("b", "m1")).toBeNull();
});

test("warm start expires at ten seconds and rejects clock rollback", () => {
  let now = 1000;
  const cache = createMachineMetricsCache(() => now);
  cache.setAccount("a");
  cache.complete(cache.begin("a", "m1"), sample());
  const snapshot = cache.snapshot("a", "m1");
  now += MACHINE_METRICS_CACHE_TTL_MS - 1;
  expect(cache.recent(snapshot)).not.toBeNull();
  now++;
  expect(cache.recent(snapshot)).toBeNull();
  now = 999;
  expect(cache.recent(snapshot)).toBeNull();
});

test("logout invalidates pending reads even after logging into the same account again", () => {
  const cache = createMachineMetricsCache();
  cache.setAccount("a");
  const old = cache.begin("a", "m1");
  cache.complete(cache.begin("a", "m1"), sample());
  cache.setAccount(null);
  expect(cache.snapshot("a", "m1").history).toEqual([]);
  expect(cache.complete(old, sample(0.9))).toBeNull();
  cache.setAccount("a");
  expect(cache.snapshot("a", "m1").latest).toBeNull();
  expect(cache.snapshot("a", "m1").history).toEqual([]);
  expect(cache.complete(old, sample(0.9))).toBeNull();
});

test("account round trips clear previous samples and reject old completions", () => {
  const cache = createMachineMetricsCache();
  cache.setAccount("a");
  const old = cache.begin("a", "m1");
  cache.complete(old, sample());
  cache.setAccount("b");
  cache.complete(cache.begin("b", "m1"), sample(0.5));
  expect(cache.complete(old, sample(0.9))).toBeNull();
  expect(cache.snapshot("b", "m1").latest?.sample.cpuUsage).toBe(0.5);
  expect(cache.snapshot("b", "m1").history.map((point) => point.sample.cpuUsage)).toEqual([0.5]);
  cache.setAccount("a");
  expect(cache.snapshot("a", "m1").latest).toBeNull();
  expect(cache.snapshot("a", "m1").history).toEqual([]);
});

test("ordinary token/session refresh for the same account preserves the cache", () => {
  const cache = createMachineMetricsCache();
  cache.setAccount("a");
  cache.complete(cache.begin("a", "m1"), sample());
  const before = cache.snapshot("a", "m1");
  cache.setAccount("a");
  expect(cache.snapshot("a", "m1")).toBe(before);
});

test("machine stop/rebuild invalidates reads and local history generation without clearing other machines", () => {
  const cache = createMachineMetricsCache();
  cache.setAccount("a");
  const old = cache.begin("a", "m1");
  cache.complete(old, sample());
  cache.complete(cache.begin("a", "m2"), sample(0.75));
  const previous = cache.snapshot("a", "m1").generation;
  cache.invalidate("a", "m1");
  expect(cache.snapshot("a", "m1").generation).not.toBe(previous);
  expect(cache.snapshot("a", "m1").latest).toBeNull();
  expect(cache.snapshot("a", "m1").history).toEqual([]);
  expect(cache.complete(old, sample(0.9))).toBeNull();
  expect(cache.snapshot("a", "m2").latest?.sample.cpuUsage).toBe(0.75);
  expect(cache.snapshot("a", "m2").history.map((point) => point.sample.cpuUsage)).toEqual([0.75]);
  expect(cache.complete(cache.begin("a", "m1"), sample(0.5))?.sample.cpuUsage).toBe(0.5);
});

test("older RPC completion cannot overwrite a newer sample or refresh its timestamp", () => {
  let now = 0;
  const cache = createMachineMetricsCache(() => now);
  cache.setAccount("a");
  const old = cache.begin("a", "m1");
  const next = cache.begin("a", "m1");
  now = 10;
  const accepted = cache.complete(next, sample(0.5));
  now = 30;
  expect(cache.complete(old, sample(0.9))).toBe(accepted);
  expect(cache.snapshot("a", "m1").latest?.receivedAt).toBe(10);
  expect(cache.snapshot("a", "m1").latest?.sample.cpuUsage).toBe(0.5);
});

test("subscriptions observe new samples and resets once, not duplicate or late completions", () => {
  const cache = createMachineMetricsCache();
  cache.setAccount("a");
  let calls = 0;
  const stop = cache.subscribe(() => calls++);
  const read = cache.begin("a", "m1");
  cache.complete(read, sample());
  cache.complete(read, sample());
  expect(calls).toBe(1);
  cache.invalidate("a", "m1");
  cache.complete(read, sample());
  expect(calls).toBe(2);
  stop();
  cache.setAccount(null);
  expect(calls).toBe(2);
});

test("panel and sidebar responses in one second share a point without mutating earlier snapshots", () => {
  let now = 1000;
  const cache = createMachineMetricsCache(() => now);
  cache.setAccount("a");
  cache.complete(cache.begin("a", "m1"), sample(0.1));
  const first = cache.snapshot("a", "m1");
  now = 1400;
  cache.complete(cache.begin("a", "m1"), sample(0.4));
  const replaced = cache.snapshot("a", "m1");
  expect(replaced.history).toEqual([replaced.latest!]);
  expect(replaced.latest?.sample.cpuUsage).toBe(0.4);
  expect(first.history[0]?.sample.cpuUsage).toBe(0.1);
  now = 2000;
  cache.complete(cache.begin("a", "m1"), sample(0.6));
  expect(cache.snapshot("a", "m1").history.map((point) => point.receivedAt)).toEqual([1400, 2000]);
  expect(replaced.history).toHaveLength(1);
});

test("late and duplicate responses neither append nor rewrite the cached curve", () => {
  let now = 1000;
  const cache = createMachineMetricsCache(() => now);
  cache.setAccount("a");
  cache.complete(cache.begin("a", "m1"), sample(0.1));
  const old = cache.begin("a", "m1");
  const next = cache.begin("a", "m1");
  now = 2000;
  cache.complete(next, sample(0.5));
  const accepted = cache.snapshot("a", "m1");
  now = 3000;
  cache.complete(old, sample(0.9));
  cache.complete(next, sample(0.8));
  expect(cache.snapshot("a", "m1")).toBe(accepted);
  expect(accepted.history.map((point) => point.sample.cpuUsage)).toEqual([0.1, 0.5]);
});

test("a later-started overlapping request with older uptime cannot erase the curve or refresh its TTL", () => {
  let now = 0;
  const cache = createMachineMetricsCache(() => now);
  cache.setAccount("a");
  for (let i = 0; i < 3; i++) {
    now = i * 1000;
    cache.complete(cache.begin("a", "m1"), { ...sample(), uptimeSeconds: 60 + i });
  }
  const panel = cache.begin("a", "m1");
  const sidebar = cache.begin("a", "m1");
  now = 3000;
  cache.complete(panel, { ...sample(0.6), uptimeSeconds: 63 });
  const accepted = cache.snapshot("a", "m1");
  expect(accepted.history).toHaveLength(4);
  let notifications = 0;
  cache.subscribe(() => notifications++);
  now = 3050;
  expect(cache.complete(sidebar, { ...sample(0.2), uptimeSeconds: 62 })).toBe(accepted.latest);
  expect(cache.snapshot("a", "m1")).toBe(accepted);
  expect(notifications).toBe(0);
  now = 3000 + MACHINE_METRICS_CACHE_TTL_MS;
  expect(cache.recent(cache.snapshot("a", "m1"))).toBeNull();
});

test("an ambiguous uptime rollback is confirmed by a subsequent request and then fences old reads", () => {
  let now = 0;
  const cache = createMachineMetricsCache(() => now);
  cache.setAccount("a");
  cache.complete(cache.begin("a", "m1"), { ...sample(), uptimeSeconds: 100 });
  const panel = cache.begin("a", "m1");
  const sidebar = cache.begin("a", "m1");
  now = 1000;
  cache.complete(panel, { ...sample(), uptimeSeconds: 101 });
  const before = cache.snapshot("a", "m1");
  now = 1500;
  cache.complete(sidebar, { ...sample(0.1), uptimeSeconds: 1 });
  expect(cache.snapshot("a", "m1")).toBe(before);

  // A read begun after the accepted 101-second sample can establish the new boot.
  const confirmation = cache.begin("a", "m1");
  const oldInFlight = cache.begin("a", "m1");
  now = 2000;
  const restarted = cache.complete(confirmation, { ...sample(0.2), uptimeSeconds: 2 });
  const after = cache.snapshot("a", "m1");
  expect(after.generation).not.toBe(before.generation);
  expect(after.history).toEqual([restarted!]);
  // Even a larger request sequence cannot resurrect a sample from the previous boot.
  now = 2100;
  expect(cache.complete(oldInFlight, { ...sample(0.9), uptimeSeconds: 102 })).toBeNull();
  expect(cache.snapshot("a", "m1")).toBe(after);
  now = 3000;
  cache.complete(cache.begin("a", "m1"), { ...sample(0.3), uptimeSeconds: 3 });
  expect(cache.snapshot("a", "m1").history.map((point) => point.sample.uptimeSeconds)).toEqual([
    2, 3,
  ]);
});

test("a confirmed reboot is causal even within the same client millisecond and only resets that machine", () => {
  const cache = createMachineMetricsCache(() => 1000);
  cache.setAccount("a");
  cache.complete(cache.begin("a", "m1"), sample());
  cache.complete(cache.begin("a", "m2"), sample(0.5));
  const other = cache.snapshot("a", "m2");
  const before = cache.snapshot("a", "m1");
  const read = cache.begin("a", "m1");
  const restarted = cache.complete(read, { ...sample(0.1), uptimeSeconds: 1 });
  const after = cache.snapshot("a", "m1");
  expect(after.generation).not.toBe(before.generation);
  expect(after.history).toEqual([restarted!]);
  expect(cache.complete(read, { ...sample(0.1), uptimeSeconds: 1 })).toBeNull();
  expect(cache.snapshot("a", "m1")).toBe(after);
  expect(cache.snapshot("a", "m2")).toBe(other);
});

test("history stays within 150 points and 2.5 minutes for both polling cadences", () => {
  for (const interval of [1000, 3000]) {
    let now = 0;
    const cache = createMachineMetricsCache(() => now);
    cache.setAccount("a");
    for (let i = 0; i < 180; i++) {
      now = i * interval;
      cache.complete(cache.begin("a", "m1"), { ...sample(), uptimeSeconds: 60 + now / 1000 });
    }
    const { history, latest } = cache.snapshot("a", "m1");
    expect(history).toHaveLength(MACHINE_METRICS_HISTORY_WINDOW_MS / interval);
    expect(history.length).toBeLessThanOrEqual(MAX_MACHINE_METRICS_SAMPLES);
    expect(history[0]?.receivedAt).toBe(now - MACHINE_METRICS_HISTORY_WINDOW_MS + interval);
    expect(history.at(-1)).toBe(latest!);
  }
});

test("ten-second gaps, clock rollback and uptime rollback start a new curve", () => {
  let now = 1000;
  const cache = createMachineMetricsCache(() => now);
  cache.setAccount("a");
  const publish = (uptimeSeconds = 60) =>
    cache.complete(cache.begin("a", "m1"), { ...sample(), uptimeSeconds });
  publish();
  now += MACHINE_METRICS_CACHE_TTL_MS - 1;
  publish();
  expect(cache.snapshot("a", "m1").history).toHaveLength(2);
  now += MACHINE_METRICS_CACHE_TTL_MS;
  publish();
  expect(cache.snapshot("a", "m1").history).toHaveLength(1);
  now += 1000;
  publish();
  expect(cache.snapshot("a", "m1").history).toHaveLength(2);
  now -= 500;
  publish();
  expect(cache.snapshot("a", "m1").history).toHaveLength(1);
  now += 1000;
  publish();
  expect(cache.snapshot("a", "m1").history).toHaveLength(2);
  now += 1000;
  publish(1);
  expect(cache.snapshot("a", "m1").history).toHaveLength(1);
  expect(cache.snapshot("a", "m1").history[0]?.sample.uptimeSeconds).toBe(1);
});

test("system info survives metric expiry and its completion does not refresh metrics or rewrite history", () => {
  let now = 1000;
  const cache = createMachineMetricsCache(() => now);
  cache.setAccount("a");
  const infoRead = cache.begin("a", "m1");
  cache.complete(cache.begin("a", "m1"), sample());
  const before = cache.snapshot("a", "m1");
  now += MACHINE_METRICS_CACHE_TTL_MS;
  const cachedInfo = cache.completeInfo(infoRead, info());
  const after = cache.snapshot("a", "m1");
  expect(after.info).toBe(cachedInfo);
  expect(after.latest).toBe(before.latest);
  expect(after.history).toBe(before.history);
  expect(cache.recent(after)).toBeNull();
  now += MACHINE_METRICS_CACHE_TTL_MS;
  expect(cache.snapshot("a", "m1").info).toBe(cachedInfo);
  cache.complete(cache.begin("a", "m1"), { ...sample(), uptimeSeconds: 80 });
  expect(cache.snapshot("a", "m1").info).toBe(cachedInfo);
  cache.setAccount("a");
  expect(cache.snapshot("a", "m1").info).toBe(cachedInfo);
});

test("system info isolates machines/accounts and only a newer info response replaces cached metadata", () => {
  let now = 1000;
  const cache = createMachineMetricsCache(() => now);
  expect(cache.completeInfo(cache.begin("a", "m1"), info())).toBeNull();
  cache.setAccount("a");
  const old = cache.begin("a", "m1");
  const next = cache.begin("a", "m1");
  const accepted = cache.completeInfo(next, info("0.15.5"));
  const before = cache.snapshot("a", "m1");
  now = 2000;
  let notifications = 0;
  cache.subscribe(() => notifications++);
  expect(cache.completeInfo(old, info())).toBe(accepted);
  expect(cache.completeInfo(next, info("0.15.5"))).toBe(accepted);
  expect(cache.snapshot("a", "m1")).toBe(before);
  expect(notifications).toBe(0);
  cache.completeInfo(cache.begin("a", "m2"), info("0.15.6", "vm-m2"));
  expect(cache.snapshot("a", "m1").info?.value.hostname).toBe("vm-m1");
  expect(cache.snapshot("a", "m2").info?.value.hostname).toBe("vm-m2");
  expect(cache.snapshot("b", "m1").info).toBeNull();
  expect(cache.completeInfo(cache.begin("b", "m1"), info())).toBeNull();
});

test("session reset, machine invalidation and confirmed reboot clear metadata and reject pending info reads", () => {
  for (const reset of ["logout", "account", "machine", "reboot"] as const) {
    const cache = createMachineMetricsCache();
    cache.setAccount("a");
    cache.complete(cache.begin("a", "m1"), sample());
    cache.completeInfo(cache.begin("a", "m1"), info());
    const pending = cache.begin("a", "m1");
    if (reset === "logout") {
      cache.setAccount(null);
      cache.setAccount("a");
    } else if (reset === "account") {
      cache.setAccount("b");
      cache.setAccount("a");
    } else if (reset === "machine") {
      cache.invalidate("a", "m1");
    } else {
      cache.complete(cache.begin("a", "m1"), { ...sample(), uptimeSeconds: 1 });
    }
    expect(cache.snapshot("a", "m1").info).toBeNull();
    expect(cache.completeInfo(pending, info())).toBeNull();
    const fresh = cache.completeInfo(cache.begin("a", "m1"), info("0.15.5"));
    expect(cache.snapshot("a", "m1").info).toBe(fresh);
    expect(fresh?.value.agentVersion).toBe("0.15.5");
  }
});
