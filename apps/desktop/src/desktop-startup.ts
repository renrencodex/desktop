interface StartupSize {
  width: number;
  height: number;
  pixelRatio: number;
}

interface DesktopStartupOptions {
  appearance: Promise<unknown>;
  readSize(): StartupSize;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(id: number): void;
  ready(): void;
}

// A cloaked/hidden WebView may throttle animation frames or font loading. This
// short bound is independent of the native fallback for a broken JS entrypoint.
export const DESKTOP_STARTUP_WAIT_MS = 750;

/** Call after the React commit, including when the app rendered an error page. */
export function scheduleDesktopStartup(options: DesktopStartupOptions): () => void {
  let stopped = false;
  let frame: number | undefined;
  let previous: StartupSize | undefined;

  const cancel = () => {
    stopped = true;
    if (frame !== undefined) options.cancelFrame(frame);
    options.clearTimer(timer);
  };
  const finish = () => {
    if (stopped) return;
    cancel();
    options.ready();
  };
  const sample = () => {
    if (stopped) return;
    const size = options.readSize();
    if (
      size.width > 0 &&
      size.height > 0 &&
      previous?.width === size.width &&
      previous.height === size.height &&
      previous.pixelRatio === size.pixelRatio
    ) {
      finish();
      return;
    }
    previous = size;
    frame = options.requestFrame(sample);
  };
  const startFrames = () => {
    if (!stopped) frame = options.requestFrame(sample);
  };
  const timer = options.setTimer(finish, DESKTOP_STARTUP_WAIT_MS);
  // Appearance failure must still display the UI; it must not wait for login,
  // session restoration or remote workspaces to become available.
  void options.appearance.then(startFrames, startFrames);
  return cancel;
}
