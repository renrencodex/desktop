import type { DesktopLayoutState } from "@cloud-machine/native-client-ui/lib/desktop-layout-state";

export interface BrowserViewport {
  width: number;
  height: number;
  pixelRatio: number;
  visible: boolean;
}
export interface NativeViewport {
  width: number;
  height: number;
  scaleFactor: number;
  minimized: boolean;
}

/** Native queries and browser frames can complete in either order during restore. */
export function createDesktopViewportController(options: {
  minimum: { width: number; height: number };
  readBrowser(): BrowserViewport;
  readNative(): Promise<NativeViewport>;
  publish(state: DesktopLayoutState): void;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  setTimer(callback: () => void, ms: number): number;
  clearTimer(id: number): void;
  now(): number;
}) {
  let state: DesktopLayoutState = { phase: "active", size: null };
  let scaleFactor = options.readBrowser().pixelRatio;
  let generation = 0;
  let frame = 0;
  let timer = 0;
  let disposed = false;
  const usable = (view: BrowserViewport) =>
    view.visible &&
    [view.width, view.height, view.pixelRatio, scaleFactor].every(
      (n) => Number.isFinite(n) && n > 0,
    ) &&
    (view.width * view.pixelRatio) / scaleFactor >= options.minimum.width - 1 &&
    (view.height * view.pixelRatio) / scaleFactor >= options.minimum.height - 1;
  const publish = (phase: DesktopLayoutState["phase"], size = state.size) => {
    state = { phase, size };
    options.publish(state);
  };
  const cancel = () => {
    generation++;
    options.cancelFrame(frame);
    options.clearTimer(timer);
    frame = timer = 0;
  };
  const suspend = () => {
    if (disposed) return;
    cancel();
    publish("suspended");
  };
  const refresh = () => {
    if (disposed) return;
    cancel();
    const epoch = generation;
    const deadline = options.now() + 1_200;
    if (!usable(options.readBrowser())) publish("suspended");
    const current = () => !disposed && epoch === generation;
    const retry = () => {
      // No background polling or unbounded frame loop. A later native/DOM event starts a new check.
      if (current() && options.readBrowser().visible && options.now() < deadline)
        timer = options.setTimer(() => {
          void verify();
        }, 50);
    };
    const verify = async () => {
      if (!current() || !options.readBrowser().visible) return;
      let native: NativeViewport | null;
      try {
        native = await options.readNative();
      } catch {
        native = null;
      } // A failed read must not permanently freeze an otherwise usable UI.
      if (!current()) return;
      if (native?.minimized) {
        publish("suspended");
        return;
      }
      if (native && Number.isFinite(native.scaleFactor) && native.scaleFactor > 0)
        scaleFactor = native.scaleFactor;
      const matches = (view: BrowserViewport) =>
        usable(view) &&
        (!native ||
          (Math.abs(view.width * view.pixelRatio - native.width) <= view.pixelRatio &&
            Math.abs(view.height * view.pixelRatio - native.height) <= view.pixelRatio));
      const initial = options.readBrowser();
      if (!matches(initial)) {
        if (state.phase !== "active" || !usable(initial)) publish("restoring");
        retry();
        return;
      }
      if (state.phase === "active") {
        publish("active", { width: initial.width, height: initial.height });
        return;
      }
      publish("restoring");
      let stableFrames = 0;
      const settle = () => {
        if (!current()) return;
        const view = options.readBrowser();
        if (
          !matches(view) ||
          view.width !== initial.width ||
          view.height !== initial.height ||
          view.pixelRatio !== initial.pixelRatio
        ) {
          retry();
          return;
        }
        if (++stableFrames < 2) {
          frame = options.requestFrame(settle);
          return;
        }
        publish("active", { width: view.width, height: view.height });
      };
      frame = options.requestFrame(settle);
    };
    frame = options.requestFrame(() => {
      void verify();
    });
  };
  const initial = options.readBrowser();
  if (usable(initial)) publish("active", { width: initial.width, height: initial.height });
  else publish("suspended");
  return {
    refresh,
    suspend,
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
