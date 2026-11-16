export interface TerminalScrollbarState {
  offsetLines: number;
  historyLines: number;
  viewportRows: number;
  alternateScreen: boolean;
}

export interface TerminalScrollbarGeometry {
  thumbSize: number;
  thumbTop: number;
  travel: number;
}

export function terminalScrollbarGeometry(
  state: TerminalScrollbarState,
  trackSize: number,
  minimumThumbSize = 20,
): TerminalScrollbarGeometry {
  const history = Math.max(0, Math.floor(state.historyLines));
  const viewport = Math.max(1, Math.floor(state.viewportRows));
  const size = Math.max(0, trackSize);
  if (size === 0 || history === 0) return { thumbSize: size, thumbTop: 0, travel: 0 };
  const thumbSize = Math.min(
    size,
    Math.max(minimumThumbSize, (size * viewport) / (history + viewport)),
  );
  const travel = Math.max(0, size - thumbSize);
  const offset = Math.max(0, Math.min(history, Math.round(state.offsetLines)));
  const thumbTop = travel * ((history - offset) / history);
  return { thumbSize, thumbTop, travel };
}

export function terminalScrollbarOffsetAt(
  state: TerminalScrollbarState,
  geometry: TerminalScrollbarGeometry,
  pointerInTrack: number,
  pointerInThumb: number,
): number {
  const history = Math.max(0, Math.floor(state.historyLines));
  if (history === 0 || geometry.travel === 0) return 0;
  const thumbTop = Math.max(0, Math.min(geometry.travel, pointerInTrack - pointerInThumb));
  return Math.max(0, Math.min(history, Math.round(history * (1 - thumbTop / geometry.travel))));
}
