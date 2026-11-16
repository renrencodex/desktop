/** Scoped signal composition for WebViews without AbortSignal.any; dispose after normal completion. */
export function combineAbortSignals(signals: readonly AbortSignal[]) {
  const controller = new AbortController();
  const sources = new Set(signals);
  const subscribed = new Set<AbortSignal>();
  const dispose = () => {
    for (const signal of subscribed) signal.removeEventListener("abort", abort);
    subscribed.clear();
  };
  const abort = () => {
    dispose();
    controller.abort();
  };
  if ([...sources].some((signal) => signal.aborted)) {
    controller.abort();
  } else {
    for (const signal of sources) {
      signal.addEventListener("abort", abort, { once: true });
      subscribed.add(signal);
    }
  }
  return { signal: controller.signal, dispose };
}
