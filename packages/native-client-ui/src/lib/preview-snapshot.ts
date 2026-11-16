import { combineAbortSignals } from "./abort-signals";

/** Decode before exposing the underlying DOM so the substitute frame is ready to paint. */
export async function decodePreviewSnapshot(dataUrl: string | null): Promise<string | null> {
  if (!dataUrl?.startsWith("data:image/png;base64,")) return null;
  const image = new Image();
  image.src = dataUrl;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      image.decode(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("snapshot decode timed out")), 500);
      }),
    ]);
    return dataUrl;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Cancellation releases the visibility queue without waiting for native capture or image decoding. */
export async function captureAndHidePreview(
  operations: {
    shouldHide: () => boolean;
    capture: () => Promise<string | null>;
    prepare: (snapshot: string | null) => Promise<string | null>;
    present: (snapshot: string | null) => void;
    hide: () => Promise<void>;
  },
  signal?: AbortSignal,
  options: { requireSnapshot?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = new AbortController();
  const combined = combineAbortSignals(signal ? [signal, deadline.signal] : [deadline.signal]);
  const lifetime = combined.signal;
  const shouldHide = () => !lifetime.aborted && operations.shouldHide();
  if (!shouldHide()) {
    combined.dispose();
    return;
  }
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => deadline.abort(), options.timeoutMs);
  let onAbort: () => void = () => {};
  const cancelled = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    lifetime.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const snapshot = await Promise.race([operations.capture().catch(() => null), cancelled]);
    if (!shouldHide()) return;
    const prepared = await Promise.race([
      operations.prepare(snapshot).catch(() => null),
      cancelled,
    ]);
    if (!shouldHide()) return;
    if (options.requireSnapshot && !prepared) return;
    // Once visibility IPC starts it must remain serialized; the deadline only bounds preparation.
    clearTimeout(timer);
    operations.present(prepared);
    // Present may synchronously commit a tab switch/unmount via React's flushSync.
    if (!shouldHide()) return;
    // Keep the actual visibility command serialized, even if cancellation arrives during IPC.
    await operations.hide();
  } finally {
    clearTimeout(timer);
    lifetime.removeEventListener("abort", onAbort);
    combined.dispose();
  }
}
