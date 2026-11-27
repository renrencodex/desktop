import type { CanvasRenderer, GhosttyTerminal, Terminal } from "ghostty-web";

const cursorHome = [0x1b, 0x5b, 0x48];

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
  isVisible: () => boolean,
  isPhoneApplication?: () => boolean,
) {
  const renderer = term.renderer!;
  const originalRender = renderer.render;
  const originalResize = renderer.resize;
  let syncUntil: number | undefined;
  let inspectClearSince: number | undefined;
  let clearUntil: number | undefined;
  let wakeAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let needsFullPaint = false;
  // An empty startup/snapshot has no previously committed output to preserve.
  let paintedOutput = false;
  let parsedOutput = false;
  let savedBitmap: HTMLCanvasElement | undefined;
  let restoreBitmap = false;

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
      syncUntil ?? clearUntil ?? (inspectClearSince === undefined ? 0 : inspectClearSince + 80);
    if (deadline && performance.now() < deadline && paintedOutput && isVisible()) {
      savedBitmap ??= copyBitmap(renderer.getCanvas());
      restoreBitmap = savedBitmap !== undefined;
    }
    originalResize.call(renderer, cols, rows);
  };

  const render: CanvasRenderer["render"] = (buffer, forceAll, viewportY, provider) => {
    if (!isVisible()) return;
    const wasm = term.wasmTerm;
    if (wasm && inspectClearSince !== undefined && !viewportY && isPhoneApplication?.()) {
      // update before reading pooled cells. Only examine them on a full-screen
      // redraw or the first paint after more output arrived during a held clear.
      const fullRedraw = wasm.needsFullRedraw();
      if ((fullRedraw || clearUntil !== undefined) && isBlankViewport(wasm)) {
        clearUntil ??= inspectClearSince + 80;
      } else {
        clearUntil = undefined;
      }
    }
    inspectClearSince = undefined;
    if (clearUntil !== undefined && (viewportY || !isPhoneApplication?.())) clearUntil = undefined;
    const deadline = syncUntil ?? clearUntil;
    if (deadline !== undefined && performance.now() < deadline) {
      if (restoreBitmap && savedBitmap) {
        const ctx = renderer.getCanvas().getContext("2d");
        if (ctx) {
          ctx.save();
          ctx.resetTransform();
          ctx.drawImage(savedBitmap, 0, 0);
          ctx.restore();
        }
        restoreBitmap = false;
      }
      needsFullPaint = true;
      wakeAtDeadline(deadline);
      return;
    }
    if (timer !== undefined) cancelWake();
    clearUntil = undefined;
    savedBitmap = undefined;
    restoreBitmap = false;
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
    needsFullPaint = false;
    paintedOutput = false;
    parsedOutput = false;
    savedBitmap = undefined;
    restoreBitmap = false;
  }

  return {
    outputParsed(data: Uint8Array) {
      parsedOutput = true;
      if (term.wasmTerm?.getMode(2026)) {
        // Keep the original deadline even after expiry until the application ends sync.
        syncUntil ??= performance.now() + 1_000;
        clearUntil = undefined;
        inspectClearSince = undefined;
      } else if (syncUntil !== undefined) {
        syncUntil = undefined;
        if (needsFullPaint && term.wasmTerm)
          renderer.render(term.wasmTerm, true, term.getViewportY(), term, 0);
        else needsFullPaint = true;
      } else if (
        clearUntil !== undefined ||
        (paintedOutput && isPhoneApplication?.() && isVisible() && endsWithPossibleErase(data))
      ) {
        inspectClearSince ??= performance.now();
      }
    },
    reset,
    dispose() {
      reset();
      if (renderer.render === render) renderer.render = originalRender;
      if (renderer.resize === resize) renderer.resize = originalResize;
      if (scrollbarMouseDown) container.addEventListener("mousedown", scrollbarMouseDown, true);
    },
  };
}
