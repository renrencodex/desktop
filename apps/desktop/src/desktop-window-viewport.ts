import type { Window as NativeWindow } from "@tauri-apps/api/window";
import config from "../src-tauri/tauri.conf.json";
import { createDesktopViewportController } from "./desktop-viewport";
import { setDesktopLayoutState } from "@cloud-machine/native-client-ui/lib/desktop-layout-state";

export function bindDesktopWindowViewport(native: NativeWindow, view: Window) {
  const root = view.document.documentElement;
  const properties = ["--cm-viewport-width", "--cm-viewport-height"] as const;
  const previous = properties.map((name) => root.style.getPropertyValue(name));
  let disposed = false;
  const stops: Array<() => void> = [];
  const restoreStyles = () =>
    properties.forEach((name, i) => {
      if (previous[i]) root.style.setProperty(name, previous[i]);
      else root.style.removeProperty(name);
    });
  const controller = createDesktopViewportController({
    minimum: { width: config.app.windows[0]!.minWidth, height: config.app.windows[0]!.minHeight },
    readBrowser: () => ({
      width: view.innerWidth,
      height: view.innerHeight,
      pixelRatio: view.devicePixelRatio,
      visible: !view.document.hidden,
    }),
    readNative: async () => {
      const [size, minimized, scaleFactor] = await Promise.all([
        native.innerSize(),
        native.isMinimized(),
        native.scaleFactor(),
      ]);
      return { ...size, minimized, scaleFactor };
    },
    publish: (state) => {
      if (state.phase !== "active" && state.size) {
        root.style.setProperty(properties[0], `${state.size.width}px`);
        root.style.setProperty(properties[1], `${state.size.height}px`);
      } else restoreStyles();
      setDesktopLayoutState(state);
    },
    requestFrame: (callback) => view.requestAnimationFrame(callback),
    cancelFrame: (id) => view.cancelAnimationFrame(id),
    setTimer: (callback, ms) => view.setTimeout(callback, ms),
    clearTimer: (id) => view.clearTimeout(id),
    now: () => view.performance.now(),
  });
  const register = (promise: Promise<() => void>) => {
    void promise
      .then((stop) => {
        if (disposed) stop();
        else stops.push(stop);
      })
      .catch((error: unknown) => console.error("Desktop viewport listener failed", error));
  };
  register(native.onFocusChanged(controller.refresh));
  register(native.onResized(controller.refresh));
  register(native.onScaleChanged(controller.refresh));
  for (const event of ["resize", "focus", "blur", "pageshow"])
    view.addEventListener(event, controller.refresh);
  view.document.addEventListener("visibilitychange", controller.refresh);
  controller.refresh();
  return {
    hideToTray() {
      controller.suspend();
      return native.hide().catch((error: unknown) => {
        controller.refresh();
        throw error;
      });
    },
    dispose() {
      disposed = true;
      controller.dispose();
      stops.forEach((stop) => stop());
      for (const event of ["resize", "focus", "blur", "pageshow"])
        view.removeEventListener(event, controller.refresh);
      view.document.removeEventListener("visibilitychange", controller.refresh);
      restoreStyles();
      setDesktopLayoutState({ phase: "active", size: null });
    },
  };
}
