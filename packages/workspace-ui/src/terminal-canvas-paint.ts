import type { CanvasRenderer, GhosttyTerminal, Terminal } from "ghostty-web";

const cursorHome = [0x1b, 0x5b, 0x48];
const MAX_UNMARKED_REPAINT_MS = 80;
const RMUX_REPAINT_QUIET_MS = 48;
// RMUX 0.10.0 projects a screen erase as row updates, often across multiple
// repaints. These are its save-cursor, hide-cursor, and first-row prefixes.
const rmuxRepaintStarts = ["\x1b[s\x1b[?25l\x1b[1;1H", "\x1b[s\x1b[?25l\x1b[0m\x1b[1;1H"] as const;
const rmuxRepaintPrefixSize = rmuxRepaintStarts[1].length - 1;
const terminalDecoder = new TextDecoder();
// eslint-disable-next-line no-control-regex -- DEC mode resets start with ESC.
const decPrivateModeReset = /\x1b\[\?[0-9;]+l/g;

function hasSynchronizedOutputEnd(output: string): boolean {
  if (!output.includes("2026")) return false;
  for (const [reset] of output.matchAll(decPrivateModeReset)) {
    if (
      reset
        .slice(3, -1)
        .split(";")
        .some((mode) => Number(mode) === 2026)
    )
      return true;
  }
  return false;
}

// Cursor's observed unmarked write ends with ED, optionally followed by CUP.
// A packet can end anywhere inside CUP. Let the WASM grid verify the erase.
function endsWithPossibleErase(data: Uint8Array): boolean {
  const erase = data.lastIndexOf(0x4a);
  const tailLength = data.length - erase - 1;
  if (erase < 0 || tailLength > cursorHome.length) return false;
  for (let i = 0; i < tailLength; i++) {
    if (data[erase + 1 + i] !== cursorHome[i]) return false;
  }
  return true;
}

// Only Ghostty calls that change the entire viewport qualify. A coloured space
// (common in TUIs), decoration or grapheme is already a presentable frame.
function isBlankViewport(buffer: GhosttyTerminal): boolean {
  const { r, g, b } = buffer.getColors().background;
  return buffer
    .getViewport()
    .every(
      (cell) =>
        (cell.codepoint === 0 || cell.codepoint === 32) &&
        cell.grapheme_len === 0 &&
        cell.flags === 0 &&
        cell.bg_r === r &&
        cell.bg_g === g &&
        cell.bg_b === b,
    );
}

function copyBitmap(source: HTMLCanvasElement): HTMLCanvasElement | undefined {
  if (!source.width || !source.height) return;
  const copy = source.ownerDocument.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  const ctx = copy.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(source, 0, 0);
  return copy;
}

export function bindGhosttyCanvasPaint(
  term: Terminal,
  container: HTMLElement,
  {
    isVisible,
    isPhoneApplication,
    isLiveCursorApplication,
  }: {
    isVisible(): boolean;
    isPhoneApplication?: () => boolean;
    isLiveCursorApplication?: () => boolean;
  },
) {
  const renderer = term.renderer!;
  const originalRender = renderer.render;
  const originalResize = renderer.resize;
  let syncUntil: number | undefined;
  let inspectClearSince: number | undefined;
  let clearUntil: number | undefined;
  let rmuxRepaintPrefix = "";
  let rmuxRepaint: { limit: number; until: number } | undefined;
  let wakeAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let needsFullPaint = false;
  // An empty startup/snapshot has no previously committed output to preserve.
  let paintedOutput = false;
  let parsedOutput = false;
  let savedBitmap: HTMLCanvasElement | undefined;
  let deferredResize: { cols: number; rows: number } | undefined;

  function cancelRmuxRepaint() {
    rmuxRepaint = undefined;
    rmuxRepaintPrefix = "";
  }

  function observeCursorOutput(data: Uint8Array): boolean {
    if (!paintedOutput || !isLiveCursorApplication?.() || !isVisible() || term.getViewportY()) {
      cancelRmuxRepaint();
      return false;
    }
    let started = false;
    if (rmuxRepaintPrefix || data.includes(0x1b)) {
      const output = rmuxRepaintPrefix + terminalDecoder.decode(data);
      // A complete DEC 2026 update can arrive in one write, leaving WASM mode off.
      if (hasSynchronizedOutputEnd(output)) {
        cancelRmuxRepaint();
        return true;
      }
      started = rmuxRepaintStarts.some((start) => output.includes(start));
      // Keep only a possible incomplete control prefix, never a copy of the stream.
      const tail = output.slice(-rmuxRepaintPrefixSize);
      rmuxRepaintPrefix = "";
      for (
        let index = tail.indexOf("\x1b");
        index !== -1;
        index = tail.indexOf("\x1b", index + 1)
      ) {
        const suffix = tail.slice(index);
        if (
          rmuxRepaintStarts.some(
            (start) => suffix.length < start.length && start.startsWith(suffix),
          )
        ) {
          rmuxRepaintPrefix = suffix;
          break;
        }
      }
    }
    if (!started && !rmuxRepaint) return false;

    const now = performance.now();
    const limit = rmuxRepaint?.limit ?? now + MAX_UNMARKED_REPAINT_MS;
    rmuxRepaint = { limit, until: Math.min(limit, now + RMUX_REPAINT_QUIET_MS) };
    return true;
  }

  function cancelWake() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    wakeAt = undefined;
  }
  function wakeAtDeadline(deadline: number) {
    if (wakeAt === deadline) return;
    cancelWake();
    wakeAt = deadline;
    timer = setTimeout(
      () => {
        timer = undefined;
        wakeAt = undefined;
        if (isVisible() && term.wasmTerm)
          renderer.render(term.wasmTerm, true, term.getViewportY(), term, 0);
      },
      Math.ceil(deadline - performance.now()),
    );
  }

  // Ghostty resize() clears the bitmap before it requests a forced render.
  // Only copy pixels when a real resize overlaps a held frame (e.g. the IME).
  const resize: CanvasRenderer["resize"] = (cols, rows) => {
    const deadline =
      syncUntil ??
      rmuxRepaint?.until ??
      clearUntil ??
      (inspectClearSince === undefined ? 0 : inspectClearSince + MAX_UNMARKED_REPAINT_MS);
    if (deadline && performance.now() < deadline && paintedOutput && isVisible()) {
      savedBitmap ??= copyBitmap(renderer.getCanvas());
      if (savedBitmap) {
        // Ghostty Terminal.resize overwrites the backing dimensions with CSS pixels.
        // Size the renderer's bitmap in device pixels after that, just before paint.
        deferredResize = { cols, rows };
        return;
      }
    }
    deferredResize = undefined;
    originalResize.call(renderer, cols, rows);
  };

  const render: CanvasRenderer["render"] = (buffer, forceAll, viewportY, provider) => {
    if (!isVisible()) {
      cancelRmuxRepaint();
      return;
    }
    const wasm = term.wasmTerm;
    if (wasm && inspectClearSince !== undefined && !viewportY && isPhoneApplication?.()) {
      // update before reading pooled cells. Only examine them on a full-screen
      // redraw or the first paint after more output arrived during a held clear.
      const fullRedraw = wasm.needsFullRedraw();
      if ((fullRedraw || clearUntil !== undefined) && isBlankViewport(wasm)) {
        clearUntil ??= inspectClearSince + MAX_UNMARKED_REPAINT_MS;
      } else {
        clearUntil = undefined;
      }
    }
    inspectClearSince = undefined;
    if (clearUntil !== undefined && (viewportY || !isPhoneApplication?.())) clearUntil = undefined;
    if (viewportY || !isLiveCursorApplication?.()) cancelRmuxRepaint();
    const deadline = syncUntil ?? rmuxRepaint?.until ?? clearUntil;
    const pendingResize = deferredResize;
    if (pendingResize) {
      deferredResize = undefined;
      originalResize.call(renderer, pendingResize.cols, pendingResize.rows);
      needsFullPaint = true;
    }
    if (deadline !== undefined && performance.now() < deadline) {
      if (pendingResize && savedBitmap) {
        const ctx = renderer.getCanvas().getContext("2d");
        if (ctx) {
          ctx.save();
          ctx.resetTransform();
          ctx.drawImage(savedBitmap, 0, 0);
          ctx.restore();
        }
      }
      needsFullPaint = true;
      wakeAtDeadline(deadline);
      return;
    }
    if (timer !== undefined) cancelWake();
    clearUntil = undefined;
    rmuxRepaint = undefined;
    savedBitmap = undefined;
    // All render entry points, including scrollbar fades, use the DOM scrollbar.
    originalRender.call(renderer, buffer, forceAll || needsFullPaint, viewportY, provider, 0);
    needsFullPaint = false;
    paintedOutput ||= parsedOutput;
  };
  renderer.render = render;
  renderer.resize = resize;
  // Ghostty 0.4.0's private hit target still intercepts the last 14px without its overlay.
  const scrollbarMouseDown = (term as unknown as { handleMouseDown?: EventListener })
    .handleMouseDown;
  if (scrollbarMouseDown) container.removeEventListener("mousedown", scrollbarMouseDown, true);
  if (term.wasmTerm) renderer.render(term.wasmTerm, true, term.getViewportY(), term, 0);

  function reset() {
    cancelWake();
    syncUntil = undefined;
    clearUntil = undefined;
    inspectClearSince = undefined;
    cancelRmuxRepaint();
    needsFullPaint = false;
    paintedOutput = false;
    parsedOutput = false;
    savedBitmap = undefined;
    deferredResize = undefined;
  }

  return {
    outputParsed(data: Uint8Array) {
      parsedOutput = true;
      if (term.wasmTerm?.getMode(2026)) {
        // Keep the original deadline even after expiry until the application ends sync.
        syncUntil ??= performance.now() + 1_000;
        clearUntil = undefined;
        inspectClearSince = undefined;
        cancelRmuxRepaint();
      } else if (syncUntil !== undefined) {
        syncUntil = undefined;
        if (needsFullPaint && term.wasmTerm)
          renderer.render(term.wasmTerm, true, term.getViewportY(), term, 0);
        else needsFullPaint = true;
      } else if (observeCursorOutput(data)) {
        // Paint only. The WASM parser and terminal responses have already run.
        clearUntil = undefined;
        inspectClearSince = undefined;
      } else if (
        clearUntil !== undefined ||
        (paintedOutput && isPhoneApplication?.() && isVisible() && endsWithPossibleErase(data))
      ) {
        inspectClearSince ??= performance.now();
      }
    },
    cancelRmuxRepaint,
    reset,
    dispose() {
      reset();
      if (renderer.render === render) renderer.render = originalRender;
      if (renderer.resize === resize) renderer.resize = originalResize;
      if (scrollbarMouseDown) container.addEventListener("mousedown", scrollbarMouseDown, true);
    },
  };
}
