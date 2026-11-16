import { createContext } from "react";

export interface PreviewLayoutParticipant {
  prepare(signal: AbortSignal): Promise<void>;
  finish(signal: AbortSignal): Promise<void>;
}

/** Scoped to one desktop shell; multiple visible split panes prepare concurrently. */
export function createPreviewLayoutCoordinator() {
  const participants = new Set<PreviewLayoutParticipant>();
  let current: AbortController | null = null;
  return {
    register(participant: PreviewLayoutParticipant) {
      participants.add(participant);
      return () => {
        participants.delete(participant);
      };
    },
    cancel() {
      current?.abort();
      current = null;
    },
    async change(apply: () => void) {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      const active = [...participants];
      try {
        await Promise.allSettled(active.map((p) => p.prepare(controller.signal)));
        if (controller.signal.aborted) return;
        apply();
        await Promise.allSettled(active.map((p) => p.finish(controller.signal)));
      } finally {
        controller.abort();
        if (current === controller) current = null;
      }
    },
  };
}

export const PreviewLayoutContext = createContext<ReturnType<
  typeof createPreviewLayoutCoordinator
> | null>(null);

/** Main-view layout stability, NOT a promise that the native renderer has painted. */
export function waitForPreviewLayout(measure: () => string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let frame = 0;
    let previous = measure();
    let stable = 0;
    const finish = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const tick = () => {
      const next = measure();
      stable = next === previous ? stable + 1 : 0;
      previous = next;
      if (stable >= 2) finish();
      else frame = requestAnimationFrame(tick);
    };
    // A minimized window can suspend animation frames. Never hold lifecycle work indefinitely.
    const timeout = setTimeout(finish, 500);
    signal.addEventListener("abort", finish, { once: true });
    frame = requestAnimationFrame(tick);
  });
}
