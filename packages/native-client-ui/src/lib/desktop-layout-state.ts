import { VIEWPORT_SYNC_EVENT } from "./visual-viewport";

export interface DesktopLayoutState {
  phase: "active" | "suspended" | "restoring";
  size: { width: number; height: number } | null;
}

let state: DesktopLayoutState = { phase: "active", size: null };
const listeners = new Set<() => void>();

export const getDesktopLayoutState = () => state;
export const desktopLayoutGate = {
  isSuspended: () => state.phase !== "active",
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function setDesktopLayoutState(next: DesktopLayoutState): void {
  if (
    state.phase === next.phase &&
    state.size?.width === next.size?.width &&
    state.size?.height === next.size?.height
  )
    return;
  state = next;
  for (const listener of listeners) listener();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(VIEWPORT_SYNC_EVENT));
}
