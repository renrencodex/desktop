/** Coalesce geometry work without allowing it to jump ahead of queued hide/close operations. */
export function createPreviewTaskQueue(
  enqueue: (task: () => Promise<void>) => Promise<void>,
  onError: () => void,
) {
  let pending: (() => Promise<void>) | null = null;
  let running = false;
  const pump = () => {
    if (running || !pending) return;
    running = true;
    void enqueue(async () => {
      const task = pending;
      pending = null;
      await task?.();
    })
      .catch(onError)
      .finally(() => {
        running = false;
        pump();
      });
  };
  return {
    request(task: () => Promise<void>) {
      pending = task;
      pump();
    },
    clear() {
      pending = null;
    },
  };
}
