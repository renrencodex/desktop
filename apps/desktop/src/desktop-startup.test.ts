import { expect, test } from "bun:test";
import { DESKTOP_STARTUP_WAIT_MS, scheduleDesktopStartup } from "./desktop-startup";

function harness() {
  const appearance = Promise.withResolvers<void>();
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let size = { width: 1920, height: 1080, pixelRatio: 1 };
  let id = 0;
  let ready = 0;
  const cancel = scheduleDesktopStartup({
    appearance: appearance.promise,
    readSize: () => size,
    requestFrame: (callback) => {
      frames.set(++id, callback);
      return id;
    },
    cancelFrame: (key) => {
      frames.delete(key);
    },
    setTimer: (callback, delay) => {
      expect(delay).toBe(DESKTOP_STARTUP_WAIT_MS);
      timers.set(++id, callback);
      return id;
    },
    clearTimer: (key) => {
      timers.delete(key);
    },
    ready: () => {
      ready++;
    },
  });
  const flush = (callbacks: Map<number, () => void>) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback();
  };
  return {
    cancel,
    appearance,
    frames,
    timers,
    get ready() {
      return ready;
    },
    resize: (value: Partial<typeof size>) => {
      size = { ...size, ...value };
    },
    frame: () => flush(frames),
    timeout: () => flush(timers),
    appeared: async () => {
      appearance.resolve();
      await Promise.resolve();
    },
  };
}

test("waits for appearance and two stable frames before notifying Native", async () => {
  const h = harness();
  h.frame();
  expect(h.ready).toBe(0);
  await h.appeared();
  h.frame();
  expect(h.ready).toBe(0);
  h.frame();
  expect(h.ready).toBe(1);
  expect(h.frames.size + h.timers.size).toBe(0);
});

test("resizing and DPI changes need another stable frame", async () => {
  const h = harness();
  await h.appeared();
  h.frame();
  h.resize({ width: 2560 });
  h.frame();
  expect(h.ready).toBe(0);
  h.resize({ pixelRatio: 1.5 });
  h.frame();
  expect(h.ready).toBe(0);
  h.frame();
  expect(h.ready).toBe(1);
});

test("zero-sized frames are not treated as ready", async () => {
  const h = harness();
  h.resize({ width: 0, height: 0 });
  await h.appeared();
  h.frame();
  h.frame();
  expect(h.ready).toBe(0);
  h.resize({ width: 1920, height: 1080 });
  h.frame();
  h.frame();
  expect(h.ready).toBe(1);
});

test("a stalled theme or fonts cannot keep the window hidden", async () => {
  const h = harness();
  h.timeout();
  expect(h.ready).toBe(1);
  await h.appeared();
  h.frame();
  expect(h.ready).toBe(1);
  expect(h.frames.size + h.timers.size).toBe(0);
});

test("throttled animation frames fall back once and ignore already queued callbacks", async () => {
  const h = harness();
  await h.appeared();
  const lateFrame = [...h.frames.values()][0]!;
  const lateTimer = [...h.timers.values()][0]!;
  h.timeout();
  lateFrame();
  lateTimer();
  expect(h.ready).toBe(1);
  expect(h.frames.size + h.timers.size).toBe(0);
});

test("an appearance failure still lets the rendered error page become visible", async () => {
  const h = harness();
  h.appearance.reject(new Error("native theme failed"));
  await Promise.resolve();
  h.frame();
  h.frame();
  expect(h.ready).toBe(1);
});

test("StrictMode cleanup cancels pending work and an independent remount can finish", async () => {
  const first = harness();
  const lateTimer = [...first.timers.values()][0]!;
  first.cancel();
  await first.appeared();
  lateTimer();
  expect(first.ready).toBe(0);
  expect(first.frames.size + first.timers.size).toBe(0);
  const second = harness();
  await second.appeared();
  second.frame();
  const lateFrame = [...second.frames.values()][0]!;
  second.cancel();
  lateFrame();
  second.timeout();
  expect(second.ready).toBe(0);
  const third = harness();
  await third.appeared();
  third.frame();
  third.frame();
  expect(third.ready).toBe(1);
});
