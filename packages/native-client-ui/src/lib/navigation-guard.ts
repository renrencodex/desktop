"use client";

import { useLayoutEffect, useRef } from "react";

import { hasActiveDismissibleHistoryLayer } from "./responsive";

export const WORKBENCH_HISTORY_INDEX = "__cloudMachineHistoryIndex";

export function readWorkbenchHistoryIndex(state: unknown): number | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[WORKBENCH_HISTORY_INDEX];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function withWorkbenchHistoryIndex(state: unknown, index: number): Record<string, unknown> {
  const record = state && typeof state === "object" ? state : {};
  return { ...record, [WORKBENCH_HISTORY_INDEX]: index };
}

/**
 * Guard browser Back/Forward navigation while an editor contains unsaved content.
 *
 * The router's pushState/replaceState calls are tagged with a monotonic local index.
 * That lets a cancelled popstate move the browser back to the exact entry it left.
 */
export function useUnsavedNavigationGuard(
  dirtyFileCount: number,
  confirmNavigation: () => boolean,
): void {
  const dirtyFileCountRef = useRef(dirtyFileCount);
  const confirmNavigationRef = useRef(confirmNavigation);

  useLayoutEffect(() => {
    dirtyFileCountRef.current = dirtyFileCount;
    confirmNavigationRef.current = confirmNavigation;
  }, [confirmNavigation, dirtyFileCount]);

  useLayoutEffect(() => {
    const history = window.history;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    let currentIndex = readWorkbenchHistoryIndex(history.state) ?? 0;
    let restoringCancelledNavigation = false;

    originalReplaceState.call(
      history,
      withWorkbenchHistoryIndex(history.state, currentIndex),
      "",
      window.location.href,
    );

    history.pushState = (state, unused, url) => {
      currentIndex += 1;
      originalPushState.call(history, withWorkbenchHistoryIndex(state, currentIndex), unused, url);
    };
    history.replaceState = (state, unused, url) => {
      originalReplaceState.call(
        history,
        withWorkbenchHistoryIndex(state, currentIndex),
        unused,
        url,
      );
    };

    const onPopState = (event: PopStateEvent) => {
      const targetIndex = readWorkbenchHistoryIndex(event.state);
      if (restoringCancelledNavigation) {
        restoringCancelledNavigation = false;
        if (targetIndex !== null) currentIndex = targetIndex;
        return;
      }
      if (hasActiveDismissibleHistoryLayer()) {
        if (targetIndex !== null) currentIndex = targetIndex;
        return;
      }

      if (dirtyFileCountRef.current > 0 && !confirmNavigationRef.current()) {
        event.stopImmediatePropagation();
        restoringCancelledNavigation = true;
        if (targetIndex === null) {
          // Untagged entries can only predate this guard, so the observed navigation was Back.
          history.forward();
        } else {
          history.go(currentIndex - targetIndex);
        }
        return;
      }

      if (targetIndex === null) {
        currentIndex -= 1;
        originalReplaceState.call(
          history,
          withWorkbenchHistoryIndex(event.state, currentIndex),
          "",
          window.location.href,
        );
      } else {
        currentIndex = targetIndex;
      }
    };

    // Capture runs before the app router's bubble listener, allowing cancellation.
    window.addEventListener("popstate", onPopState, { capture: true });
    return () => {
      window.removeEventListener("popstate", onPopState, { capture: true });
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
    };
  }, []);
}
