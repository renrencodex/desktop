"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { bindVisualViewport, VIEWPORT_SYNC_EVENT } from "./visual-viewport";
import { desktopLayoutGate, getDesktopLayoutState } from "./desktop-layout-state";

export const PHONE_MEDIA_QUERY = "(max-width: 639px)";
export const COMPACT_MEDIA_QUERY = "(max-width: 1023px)";
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

export type ViewportMode = "phone" | "tablet" | "desktop";

interface MediaQueryState {
  matches: boolean;
  resolved: boolean;
}

const subscribeNever = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;
const stableMediaQueryMatches = new Map<string, boolean>();
export function getMediaQuerySnapshot(query: string): boolean {
  if (typeof window.matchMedia !== "function") return false;
  const current = window.matchMedia(query).matches;
  if (desktopLayoutGate.isSuspended()) {
    const size = getDesktopLayoutState().size;
    if (size && query === PHONE_MEDIA_QUERY) return size.width < 640;
    if (size && query === COMPACT_MEDIA_QUERY) return size.width < 1024;
  }
  if (!desktopLayoutGate.isSuspended() || !stableMediaQueryMatches.has(query)) {
    stableMediaQueryMatches.set(query, current);
  }
  return stableMediaQueryMatches.get(query) ?? current;
}

export function viewportModeForWidth(width: number): ViewportMode {
  if (width < 640) return "phone";
  if (width < 1024) return "tablet";
  return "desktop";
}

function useMediaQueryState(query: string): MediaQueryState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(query);
      window.addEventListener(VIEWPORT_SYNC_EVENT, onStoreChange);
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", onStoreChange);
        return () => {
          media.removeEventListener("change", onStoreChange);
          window.removeEventListener(VIEWPORT_SYNC_EVENT, onStoreChange);
        };
      }
      media.addListener(onStoreChange);
      return () => {
        media.removeListener(onStoreChange);
        window.removeEventListener(VIEWPORT_SYNC_EVENT, onStoreChange);
      };
    },
    [query],
  );
  const getSnapshot = useCallback(() => getMediaQuerySnapshot(query), [query]);
  const matches = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const resolved = useSyncExternalStore(subscribeNever, getClientSnapshot, getServerSnapshot);

  return { matches, resolved };
}

export function useMediaQuery(query: string): boolean {
  return useMediaQueryState(query).matches;
}

export function useResponsiveViewport(): {
  mode: ViewportMode;
  isPhone: boolean;
  isCompact: boolean;
  isCoarsePointer: boolean;
  isResolved: boolean;
} {
  const phone = useMediaQueryState(PHONE_MEDIA_QUERY);
  const compact = useMediaQueryState(COMPACT_MEDIA_QUERY);
  const coarsePointer = useMediaQueryState(COARSE_POINTER_QUERY);
  const isResolved = phone.resolved && compact.resolved && coarsePointer.resolved;

  return useMemo(
    () => ({
      mode: phone.matches ? "phone" : compact.matches ? "tablet" : "desktop",
      isPhone: phone.matches,
      isCompact: compact.matches,
      isCoarsePointer: coarsePointer.matches,
      isResolved,
    }),
    [coarsePointer.matches, compact.matches, isResolved, phone.matches],
  );
}

/**
 * Mobile browsers do not consistently shrink 100vh/100dvh while their software
 * keyboard is open. visualViewport is the closest representation of the usable
 * application area, so expose it as a CSS variable for the full-screen shell.
 */
export function useVisualViewportHeight(): void {
  useEffect(() => bindVisualViewport(window), []);
}

/**
 * iOS/Android shrink the visual viewport while the software keyboard is open.
 * Treat a large shrink as "keyboard open" so bottom toolbars can get out of
 * the way instead of sandwiching the remaining terminal/editor area.
 */
export function useVirtualKeyboardOpen(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const viewport = window.visualViewport;
    window.addEventListener("resize", onChange);
    window.addEventListener(VIEWPORT_SYNC_EVENT, onChange);
    viewport?.addEventListener("resize", onChange);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener(VIEWPORT_SYNC_EVENT, onChange);
      viewport?.removeEventListener("resize", onChange);
    };
  }, []);
  const getKeyboardSnapshot = useCallback(() => {
    const viewport = window.visualViewport;
    if (!viewport) return false;
    // 乘回 scale，避免捏合缩放（visualViewport 随放大等比缩小）被误判为键盘弹出。
    return viewport.height * viewport.scale < window.innerHeight * 0.75;
  }, []);
  return useSyncExternalStore(subscribe, getKeyboardSnapshot, () => false);
}

/** 浏览器在线状态；SSR 与初始帧按在线处理。 */
export function useOnlineStatus(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    window.addEventListener("online", onChange);
    window.addEventListener("offline", onChange);
    return () => {
      window.removeEventListener("online", onChange);
      window.removeEventListener("offline", onChange);
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

const HISTORY_LAYER_STATE_KEY = "__cmDismissibleLayer";
let historyLayerSequence = 0;
const activeHistoryLayers = new Set<string>();

export function hasActiveDismissibleHistoryLayer(): boolean {
  return activeHistoryLayers.size > 0;
}

/**
 * Adds a same-page history entry while a mobile drawer is open. The first browser
 * back gesture consumes that entry and dismisses the drawer instead of leaving
 * the current screen. The returned callback releases the layer for a navigation
 * that will replace the temporary history entry.
 */
export function useBackDismiss(open: boolean, onDismiss: () => void, name: string): () => void {
  const dismissRef = useRef(onDismiss);
  const layerTokenRef = useRef<string | null>(null);
  const layerActiveRef = useRef(false);

  const releaseForNavigation = useCallback(() => {
    const token = layerTokenRef.current;
    layerActiveRef.current = false;
    layerTokenRef.current = null;
    if (token) activeHistoryLayers.delete(token);
  }, []);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const onPopState = () => {
      const token = layerTokenRef.current;
      if (!layerActiveRef.current || token === null) return;
      const state = window.history.state as Record<string, unknown> | null;
      if (state?.[HISTORY_LAYER_STATE_KEY] === token) return;
      layerActiveRef.current = false;
      layerTokenRef.current = null;
      activeHistoryLayers.delete(token);
      dismissRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (open && !layerActiveRef.current) {
      const token = `${name}:${++historyLayerSequence}`;
      const currentState = window.history.state;
      const nextState =
        typeof currentState === "object" && currentState !== null
          ? { ...currentState, [HISTORY_LAYER_STATE_KEY]: token }
          : { [HISTORY_LAYER_STATE_KEY]: token };
      window.history.pushState(nextState, "", window.location.href);
      layerTokenRef.current = token;
      layerActiveRef.current = true;
      activeHistoryLayers.add(token);
      return;
    }

    if (!open && layerActiveRef.current) {
      const token = layerTokenRef.current;
      const state = window.history.state as Record<string, unknown> | null;
      if (state?.[HISTORY_LAYER_STATE_KEY] === token) {
        window.history.back();
      } else {
        layerActiveRef.current = false;
        layerTokenRef.current = null;
        if (token) activeHistoryLayers.delete(token);
      }
    }
  }, [name, open]);

  return releaseForNavigation;
}
