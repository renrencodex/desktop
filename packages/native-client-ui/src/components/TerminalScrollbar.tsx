import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  terminalScrollbarGeometry,
  terminalScrollbarOffsetAt,
  type TerminalScrollbarState,
} from "../lib/terminal-scrollbar-model";

export function TerminalScrollbar({
  state,
  disabled = false,
  onSeek,
  onInteractionEnd,
}: {
  state: TerminalScrollbarState;
  disabled?: boolean;
  onSeek: (offsetLines: number) => void;
  onInteractionEnd?: () => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; pointerInThumb: number } | null>(null);
  const frameRef = useRef(0);
  const pendingOffsetRef = useRef<number | null>(null);
  const [trackSize, setTrackSize] = useState(0);
  const visible = state.historyLines > 0 && !state.alternateScreen;
  const latestStateRef = useRef(state);
  const latestSeekRef = useRef(onSeek);

  useLayoutEffect(() => {
    latestStateRef.current = state;
    latestSeekRef.current = onSeek;
  }, [onSeek, state]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  useLayoutEffect(() => {
    if (visible && !disabled) return;
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    pendingOffsetRef.current = null;
    dragRef.current = null;
  }, [disabled, visible]);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const sync = () => setTrackSize(track.getBoundingClientRect().height);
    sync();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(track);
    return () => observer?.disconnect();
  }, [visible]);

  if (!visible) return null;

  const flushSeek = () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    const offset = pendingOffsetRef.current;
    pendingOffsetRef.current = null;
    if (offset !== null) latestSeekRef.current(offset);
  };
  const scheduleSeek = (offset: number) => {
    pendingOffsetRef.current = offset;
    if (!frameRef.current)
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0;
        const pending = pendingOffsetRef.current;
        pendingOffsetRef.current = null;
        if (pending !== null) latestSeekRef.current(pending);
      });
  };
  const offsetAt = (clientY: number, pointerInThumb: number) => {
    const track = trackRef.current;
    if (!track) return state.offsetLines;
    const rect = track.getBoundingClientRect();
    const geometry = terminalScrollbarGeometry(latestStateRef.current, rect.height);
    return terminalScrollbarOffsetAt(
      latestStateRef.current,
      geometry,
      clientY - rect.top,
      pointerInThumb,
    );
  };

  const currentGeometry = terminalScrollbarGeometry(state, trackSize);
  const positionFromTop = Math.max(0, state.historyLines - state.offsetLines);

  return (
    <div
      ref={trackRef}
      role="scrollbar"
      aria-label="终端历史"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={state.historyLines}
      aria-valuenow={positionFromTop}
      aria-valuetext={state.offsetLines === 0 ? "实时输出" : `距实时输出 ${state.offsetLines} 行`}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className="cm-terminal-scrollbar absolute inset-y-0 right-0 z-20 hidden w-3 touch-none select-none sm:block"
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        const track = trackRef.current;
        if (!track) return;
        const rect = track.getBoundingClientRect();
        const geometry = terminalScrollbarGeometry(state, rect.height);
        const thumb = (event.target as HTMLElement).closest("[data-terminal-scrollbar-thumb]");
        const pointerInThumb = thumb
          ? Math.max(0, Math.min(geometry.thumbSize, event.clientY - rect.top - geometry.thumbTop))
          : geometry.thumbSize / 2;
        dragRef.current = { pointerId: event.pointerId, pointerInThumb };
        track.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
        scheduleSeek(offsetAt(event.clientY, pointerInThumb));
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (disabled || !drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        scheduleSeek(offsetAt(event.clientY, drag.pointerInThumb));
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        scheduleSeek(offsetAt(event.clientY, drag.pointerInThumb));
        flushSeek();
        dragRef.current = null;
        if (trackRef.current?.hasPointerCapture(event.pointerId))
          trackRef.current.releasePointerCapture(event.pointerId);
        onInteractionEnd?.();
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        flushSeek();
        dragRef.current = null;
        onInteractionEnd?.();
      }}
      onLostPointerCapture={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        flushSeek();
        dragRef.current = null;
        onInteractionEnd?.();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        let offset: number | null = null;
        switch (event.key) {
          case "ArrowUp":
            offset = state.offsetLines + 1;
            break;
          case "ArrowDown":
            offset = state.offsetLines - 1;
            break;
          case "PageUp":
            offset = state.offsetLines + state.viewportRows;
            break;
          case "PageDown":
            offset = state.offsetLines - state.viewportRows;
            break;
          case "Home":
            offset = state.historyLines;
            break;
          case "End":
            offset = 0;
            break;
        }
        if (offset === null) return;
        event.preventDefault();
        onSeek(Math.max(0, Math.min(state.historyLines, offset)));
      }}
    >
      <span
        data-terminal-scrollbar-thumb
        aria-hidden="true"
        className="cm-terminal-scrollbar-thumb absolute right-1 w-1 rounded-full"
        style={{
          height: `${currentGeometry.thumbSize}px`,
          top: `${currentGeometry.thumbTop}px`,
          visibility: trackSize > 0 ? "visible" : "hidden",
        }}
      />
    </div>
  );
}
