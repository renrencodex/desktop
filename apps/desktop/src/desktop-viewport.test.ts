import { expect, test } from "bun:test";
import {
  createDesktopViewportController,
  type BrowserViewport,
  type NativeViewport,
} from "./desktop-viewport";
import type { DesktopLayoutState } from "@cloud-machine/native-client-ui/lib/desktop-layout-state";

function harness() {
  let browser: BrowserViewport = { width: 1280, height: 800, pixelRatio: 1, visible: true };
  let native: NativeViewport = { width: 1280, height: 800, scaleFactor: 1, minimized: false };
  let read = () => Promise.resolve(native);
  let state: DesktopLayoutState;
  let id = 0;
  let now = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const controller = createDesktopViewportController({
    minimum: { width: 960, height: 600 },
    readBrowser: () => browser,
    readNative: () => read(),
    publish: (next) => {
      state = next;
    },
    requestFrame: (callback) => {
      frames.set(++id, callback);
      return id;
    },
    cancelFrame: (key) => {
      frames.delete(key);
    },
    setTimer: (callback) => {
      timers.set(++id, callback);
      return id;
    },
    clearTimer: (key) => {
      timers.delete(key);
    },
    now: () => now,
  });
  const flush = async (callbacks: Map<number, () => void>) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback());
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    controller,
    frames,
    timers,
    get state() {
      return state!;
    },
    browser(value: Partial<BrowserViewport>) {
      browser = { ...browser, ...value };
    },
    native(value: Partial<NativeViewport>) {
      native = { ...native, ...value };
    },
    reader(value: typeof read) {
      read = value;
    },
    frame: () => flush(frames),
    timer: () => {
      now += 50;
      return flush(timers);
    },
  };
}

test("early focus cannot accept a tiny WebView; restore needs matching geometry and two frames", async () => {
  const h = harness();
  h.controller.suspend();
  h.browser({ width: 160, height: 60 });
  h.controller.refresh();
  await h.frame();
  expect(h.state.phase).toBe("restoring");
  expect(h.state.size).toEqual({ width: 1280, height: 800 });
  h.browser({ width: 1280, height: 800 });
  await h.timer();
  await h.frame();
  expect(h.state.phase).toBe("restoring");
  await h.frame();
  expect(h.state.phase).toBe("active");
});

test("native minimized state wins even if WebView still reports its old full size", async () => {
  const h = harness();
  h.native({ minimized: true });
  h.controller.refresh();
  await h.frame();
  expect(h.state.phase).toBe("suspended");
  expect(h.frames.size + h.timers.size).toBe(0);
});

test("ordinary focus loss and normal resizing do not suspend the layout", async () => {
  const h = harness();
  h.controller.refresh();
  await h.frame();
  expect(h.state.phase).toBe("active");
  h.browser({ width: 1100 });
  h.native({ width: 1100 });
  h.controller.refresh();
  await h.frame();
  expect(h.state).toEqual({ phase: "active", size: { width: 1100, height: 800 } });
});

test("restoring at the configured narrow width stays valid (not hard-coded to desktop breakpoint)", async () => {
  const h = harness();
  h.controller.suspend();
  h.browser({ width: 960 });
  h.native({ width: 960 });
  h.controller.refresh();
  await h.frame();
  await h.frame();
  await h.frame();
  expect(h.state).toEqual({ phase: "active", size: { width: 960, height: 800 } });
});

test("DPI changes compare physical native dimensions with scaled CSS pixels", async () => {
  const h = harness();
  h.controller.suspend();
  h.browser({ pixelRatio: 2 });
  h.native({ scaleFactor: 2, width: 2560, height: 1600 });
  h.controller.refresh();
  await h.frame();
  await h.frame();
  await h.frame();
  expect(h.state.phase).toBe("active");
  expect(h.state.size).toEqual({ width: 1280, height: 800 });
});

test("a stale native query cannot resume a newer minimize", async () => {
  const h = harness();
  const pending = Promise.withResolvers<NativeViewport>();
  h.reader(() => pending.promise);
  h.controller.refresh();
  await h.frame();
  h.controller.suspend();
  pending.resolve({ width: 1280, height: 800, minimized: false, scaleFactor: 1 });
  await h.frame();
  await h.frame();
  expect(h.state.phase).toBe("suspended");
});

test("a second minimize cancels a partially settled restore", async () => {
  const h = harness();
  h.controller.suspend();
  h.controller.refresh();
  await h.frame();
  await h.frame();
  h.controller.suspend();
  await h.frame();
  expect(h.state.phase).toBe("suspended");
  expect(h.frames.size).toBe(0);
});

test("a failed minimize can reconcile the still-visible window", async () => {
  const h = harness();
  h.controller.suspend();
  h.controller.refresh();
  await h.frame();
  await h.frame();
  await h.frame();
  expect(h.state.phase).toBe("active");
});

test("native read failure falls back to stable usable DOM geometry, never tiny dimensions", async () => {
  const h = harness();
  h.reader(async () => {
    throw Error("IPC");
  });
  h.controller.suspend();
  h.browser({ width: 100 });
  h.controller.refresh();
  await h.frame();
  expect(h.state.phase).toBe("restoring");
  h.browser({ width: 1280 });
  await h.timer();
  await h.frame();
  await h.frame();
  expect(h.state.phase).toBe("active");
});

test("hidden documents and disposal cancel recovery without publishing late results", async () => {
  const h = harness();
  h.browser({ visible: false });
  h.controller.refresh();
  await h.frame();
  expect(h.state.phase).toBe("suspended");
  expect(h.frames.size + h.timers.size).toBe(0);
  h.browser({ visible: true });
  h.controller.refresh();
  await h.frame();
  h.controller.dispose();
  const before = h.state;
  await h.frame();
  h.controller.refresh();
  h.controller.suspend();
  expect(h.state).toBe(before);
  expect(h.frames.size + h.timers.size).toBe(0);
});

test("inconsistent dimensions stop polling at the deadline and require a fresh event", async () => {
  const h = harness();
  h.controller.suspend();
  h.browser({ width: 100 });
  h.controller.refresh();
  await h.frame();
  for (let i = 0; i < 30; i++) await h.timer();
  expect(h.state.phase).not.toBe("active");
  expect(h.frames.size + h.timers.size).toBe(0);
  h.browser({ width: 1280 });
  h.controller.refresh();
  await h.frame();
  await h.frame();
  await h.frame();
  expect(h.state.phase).toBe("active");
});
