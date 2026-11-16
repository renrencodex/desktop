"use client";

import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";

export interface NativePreviewOcclusionState {
  blockers: ReadonlySet<string>;
  setBlocked: (id: string, blocked: boolean) => void;
}

export function createNativePreviewOcclusionStore(): StoreApi<NativePreviewOcclusionState> {
  return createStore<NativePreviewOcclusionState>((set) => ({
    blockers: new Set<string>(),
    setBlocked: (id, blocked) =>
      set((state) => {
        const currentlyBlocked = state.blockers.has(id);
        if (currentlyBlocked === blocked) return state;
        const blockers = new Set(state.blockers);
        if (blocked) blockers.add(id);
        else blockers.delete(id);
        return { blockers };
      }),
  }));
}

export const nativePreviewOcclusionStore = createNativePreviewOcclusionStore();

export function isNativePreviewOccluded(
  store: StoreApi<NativePreviewOcclusionState> = nativePreviewOcclusionStore,
): boolean {
  return store.getState().blockers.size > 0;
}

type PreviewRect = Pick<DOMRect, "left" | "top" | "right" | "bottom">;

export function previewRectsOverlap(preview: PreviewRect, overlay: PreviewRect): boolean {
  return (
    preview.right > preview.left &&
    preview.bottom > preview.top &&
    overlay.right > overlay.left &&
    overlay.bottom > overlay.top &&
    preview.left < overlay.right &&
    preview.right > overlay.left &&
    preview.top < overlay.bottom &&
    preview.bottom > overlay.top
  );
}

// Include dialog backdrops and submenu popups, and keep tracking during closing animations.
const OVERLAY_SELECTOR = [
  "dropdown-menu-content",
  "dropdown-menu-sub-content",
  "context-menu-content",
  "dialog-overlay",
  "dialog-content",
]
  .map((slot) => `[data-slot="${slot}"]`)
  .join(",");

export function isPreviewElementOccluded(element: HTMLElement | null): boolean {
  if (!element || !isNativePreviewOccluded()) return false;
  const preview = element.getBoundingClientRect();
  return Array.from(element.ownerDocument.querySelectorAll(OVERLAY_SELECTOR)).some((overlay) =>
    previewRectsOverlap(preview, overlay.getBoundingClientRect()),
  );
}

export function useNativePreviewOccluded(container: RefObject<HTMLElement | null>): boolean {
  const blocked = useStore(nativePreviewOcclusionStore, (state) => state.blockers.size > 0);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!blocked) return () => {};
      let frame = 0;
      const measure = () => {
        notify();
        frame = requestAnimationFrame(measure);
      };
      frame = requestAnimationFrame(measure);
      return () => cancelAnimationFrame(frame);
    },
    [blocked],
  );
  const getSnapshot = useCallback(
    () => blocked && isPreviewElementOccluded(container.current),
    [blocked, container],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

interface OverlayTrackingProps<Details> {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, details: Details) => void;
  onOpenChangeComplete?: (open: boolean) => void;
}

/**
 * Track portal lifetimes including their closing animation. Each preview checks actual overlap
 * before capturing/hiding its native child WebView.
 */
export function useNativePreviewOverlayTracking<Details>(props: OverlayTrackingProps<Details>) {
  const blockerId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(props.defaultOpen ?? false);
  const resolvedOpen = props.open ?? uncontrolledOpen;
  const resolvedOpenRef = useRef(resolvedOpen);
  const setBlocked = nativePreviewOcclusionStore.getState().setBlocked;

  useLayoutEffect(() => {
    resolvedOpenRef.current = resolvedOpen;
    if (resolvedOpen) setBlocked(blockerId, true);
  }, [blockerId, resolvedOpen, setBlocked]);

  useLayoutEffect(
    () => () => {
      setBlocked(blockerId, false);
    },
    [blockerId, setBlocked],
  );

  return {
    onOpenChange(open: boolean, details: Details) {
      if (props.open === undefined) {
        resolvedOpenRef.current = open;
        setUncontrolledOpen(open);
      }
      if (open) setBlocked(blockerId, true);
      props.onOpenChange?.(open, details);
    },
    onOpenChangeComplete(open: boolean) {
      // A closing animation may complete after the overlay has already reopened.
      setBlocked(blockerId, open || resolvedOpenRef.current);
      props.onOpenChangeComplete?.(open);
    },
  };
}
