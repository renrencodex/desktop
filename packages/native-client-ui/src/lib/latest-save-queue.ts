/**
 * Serial latest-value save queue.
 *
 * Debounced UI updates are collapsed to the newest value, writes never overlap, and dispose()
 * flushes the final pending value without attempting to update unmounted React state.
 */
export type SaveQueueStatus = "saving" | "saved" | "error";

export interface LatestSaveQueue<T> {
  activate(): void;
  schedule(value: T): void;
  retry(): void;
  flush(): void;
  discardPending(): void;
  runExclusive<TResult>(action: () => Promise<TResult>): Promise<TResult>;
  dispose(): void;
}

export function createLatestSaveQueue<TInput, TOutput = TInput>(options: {
  delayMs: number;
  save: (value: TInput) => Promise<TOutput>;
  onSaved: (saved: TOutput, submitted: TInput) => void;
  onStatus: (status: SaveQueueStatus) => void;
}): LatestSaveQueue<TInput> {
  let pending: TInput | undefined;
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let blockedByError = false;
  let disposed = false;
  let exclusivePending = 0;
  let exclusiveTail: Promise<void> = Promise.resolve();

  const setStatus = (status: SaveQueueStatus) => {
    if (!disposed) options.onStatus(status);
  };

  const drain = () => {
    if (active || exclusivePending > 0 || pending === undefined || blockedByError) return;
    const value = pending;
    pending = undefined;
    let continueWithNewerValue = true;
    active = options
      .save(value)
      .then((saved) => {
        options.onSaved(saved, value);
        setStatus(pending === undefined ? "saved" : "saving");
      })
      .catch(() => {
        if (pending === undefined) {
          pending = value;
          blockedByError = true;
          continueWithNewerValue = false;
          setStatus("error");
        }
      })
      .finally(() => {
        active = null;
        if (continueWithNewerValue && pending !== undefined) drain();
      });
  };

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  return {
    activate() {
      disposed = false;
    },
    schedule(value) {
      pending = value;
      blockedByError = false;
      setStatus("saving");
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        drain();
      }, options.delayMs);
    },
    retry() {
      blockedByError = false;
      setStatus("saving");
      drain();
    },
    flush() {
      clearTimer();
      blockedByError = false;
      drain();
    },
    discardPending() {
      clearTimer();
      pending = undefined;
      blockedByError = false;
      setStatus(active ? "saving" : "saved");
    },
    runExclusive<TResult>(action: () => Promise<TResult>) {
      exclusivePending += 1;
      const run = exclusiveTail.then(async () => {
        clearTimer();
        while (active) await active;
        try {
          return await action();
        } finally {
          exclusivePending -= 1;
          if (exclusivePending === 0) drain();
        }
      });
      exclusiveTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    dispose() {
      disposed = true;
      clearTimer();
      blockedByError = false;
      drain();
    },
  };
}
