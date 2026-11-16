import { isTouchScrollWheel } from "./terminal-touch";

type MouseTrackingMode = "x10" | "vt200" | "drag" | "any";
type MouseEncoding = "legacy" | "utf8" | "sgr" | "urxvt" | "sgr-pixels";

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_PAGE = 2;

interface GhosttyMouseTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly options: { disableStdin: boolean };
  readonly renderer?: { getCanvas(): HTMLCanvasElement };
  focus(): void;
  getMode(mode: number, isAnsi?: boolean): boolean;
  hasMouseTracking(): boolean;
  input(data: string, wasUserInput?: boolean): void;
  onRender(listener: () => void): { dispose(): void };
  attachCustomWheelEventHandler(handler?: (event: WheelEvent) => boolean): void;
}

interface MouseProtocol {
  tracking: MouseTrackingMode;
  encoding: MouseEncoding;
}

interface MousePosition {
  cellX: number;
  cellY: number;
  pixelX: number;
  pixelY: number;
}

interface MouseReport {
  button: number;
  release?: boolean;
  motion?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  position: MousePosition;
}

interface PendingLeftClick {
  position: MousePosition;
  alt: boolean;
  ctrl: boolean;
  moved: boolean;
}

function activeProtocol(term: GhosttyMouseTerminal): MouseProtocol | null {
  if (term.options.disableStdin || !term.hasMouseTracking()) return null;

  const tracking: MouseTrackingMode | null = term.getMode(1003)
    ? "any"
    : term.getMode(1002)
      ? "drag"
      : term.getMode(1000)
        ? "vt200"
        : term.getMode(9)
          ? "x10"
          : null;
  if (!tracking) return null;

  const encoding: MouseEncoding = term.getMode(1016)
    ? "sgr-pixels"
    : term.getMode(1006)
      ? "sgr"
      : term.getMode(1015)
        ? "urxvt"
        : term.getMode(1005)
          ? "utf8"
          : "legacy";
  return { tracking, encoding };
}

function modifiers(event: MouseEvent): number {
  return (
    (event.shiftKey ? 4 : 0) + (event.altKey || event.metaKey ? 8 : 0) + (event.ctrlKey ? 16 : 0)
  );
}

/** Encode the DEC mouse protocols understood by terminal TUIs and multiplexers. */
export function encodeTerminalMouseReport(
  protocol: MouseProtocol,
  report: MouseReport,
): string | Uint8Array | null {
  if (protocol.tracking === "x10" && report.release) return null;

  const sgr = protocol.encoding === "sgr" || protocol.encoding === "sgr-pixels";
  const button = report.release && !sgr ? 3 : report.button;
  const code =
    button +
    (report.motion ? 32 : 0) +
    (protocol.tracking !== "x10" && report.alt ? 8 : 0) +
    (protocol.tracking !== "x10" && report.ctrl ? 16 : 0);
  const x = protocol.encoding === "sgr-pixels" ? report.position.pixelX : report.position.cellX;
  const y = protocol.encoding === "sgr-pixels" ? report.position.pixelY : report.position.cellY;

  if (sgr) {
    return `\u001b[<${code};${x};${y}${report.release ? "m" : "M"}`;
  }
  if (protocol.encoding === "urxvt") return `\u001b[${code + 32};${x};${y}M`;

  const values = [code + 32, x + 32, y + 32];
  const utf8 = protocol.encoding === "utf8";
  const limit = utf8 ? 2_047 : 255;
  if (values.some((value) => value > limit)) return null;
  if (utf8) return `\u001b[M${values.map((value) => String.fromCodePoint(value)).join("")}`;
  return Uint8Array.of(0x1b, 0x5b, 0x4d, ...values);
}

function mouseButton(button: number): number | null {
  if (button === 0) return 0;
  if (button === 1) return 1;
  if (button === 2) return 2;
  return null;
}

function pressedButton(buttons: number): number {
  if (buttons & 1) return 0;
  if (buttons & 4) return 1;
  if (buttons & 2) return 2;
  return 3;
}

function eventPosition(
  event: MouseEvent,
  canvas: HTMLCanvasElement,
  cols: number,
  rows: number,
): MousePosition | null {
  const rect = canvas.getBoundingClientRect();
  if (
    !(rect.width > 0) ||
    !(rect.height > 0) ||
    !Number.isFinite(event.clientX) ||
    !Number.isFinite(event.clientY) ||
    cols < 1 ||
    rows < 1
  )
    return null;
  const offsetX = Math.max(0, Math.min(event.clientX - rect.left, Math.max(0, rect.width - 1e-6)));
  const offsetY = Math.max(0, Math.min(event.clientY - rect.top, Math.max(0, rect.height - 1e-6)));
  return {
    cellX: Math.min(cols, Math.floor((offsetX / rect.width) * cols) + 1),
    cellY: Math.min(rows, Math.floor((offsetY / rect.height) * rows) + 1),
    pixelX: Math.floor(offsetX),
    pixelY: Math.floor(offsetY),
  };
}

/**
 * ghostty-web 0.4 parses mouse modes but does not emit mouse reports. Bridge
 * browser mouse events into its regular onData stream until the renderer does.
 * Left-button drags remain local text selection; clicks and wheel events are
 * forwarded to the TUI. The right button remains available to the app's
 * copy/paste context menu.
 */
export function attachGhosttyMouseReporting(
  term: GhosttyMouseTerminal,
  container: HTMLElement,
  emitBinary: (data: Uint8Array) => void,
): { reset(): void; dispose(): void } {
  const canvas = term.renderer?.getCanvas();
  if (!canvas) return { reset() {}, dispose() {} };

  const pressed = new Set<number>();
  const selecting = new Set<number>();
  let pendingLeftClick: PendingLeftClick | null = null;
  let lastMotion = "";
  let wheelAxis: "horizontal" | "vertical" | null = null;
  let wheelRemainder = 0;

  const reset = () => {
    pressed.clear();
    selecting.clear();
    pendingLeftClick = null;
    lastMotion = "";
    wheelAxis = null;
    wheelRemainder = 0;
  };

  const syncMouseTracking = () => {
    const protocol = activeProtocol(term);
    container.toggleAttribute("data-terminal-mouse-tracking", protocol !== null);
    return protocol;
  };
  const renderSubscription = term.onRender(syncMouseTracking);
  syncMouseTracking();

  const emitAt = (
    position: MousePosition,
    protocol: MouseProtocol,
    report: Omit<MouseReport, "position">,
  ) => {
    const data = encodeTerminalMouseReport(protocol, { ...report, position });
    if (!data) return false;
    if (typeof data === "string") term.input(data, true);
    else emitBinary(data);
    return true;
  };

  const emit = (
    event: MouseEvent,
    protocol: MouseProtocol,
    report: Omit<MouseReport, "position">,
  ) => {
    const position = eventPosition(event, canvas, term.cols, term.rows);
    return position ? emitAt(position, protocol, report) : false;
  };

  const consume = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onMouseDown = (event: MouseEvent) => {
    // Shift+drag preserves local selection even while a TUI owns the mouse.
    if (event.shiftKey) {
      const button = mouseButton(event.button);
      if (button !== null) selecting.add(button);
      return;
    }
    const protocol = syncMouseTracking();
    const button = mouseButton(event.button);
    // Reserve right-click for the terminal's existing copy/paste menu.
    if (!protocol || button === null || button === 2) return;
    term.focus();
    lastMotion = "";
    if (button === 0) {
      const position = eventPosition(event, canvas, term.cols, term.rows);
      if (!position) return;
      pendingLeftClick = {
        position,
        alt: event.altKey || event.metaKey,
        ctrl: event.ctrlKey,
        // A double/triple click belongs to the renderer's word/line selection.
        moved: event.detail > 1,
      };
      return;
    }
    pressed.add(button);
    if (
      emit(event, protocol, {
        button,
        alt: event.altKey || event.metaKey,
        ctrl: event.ctrlKey,
      })
    )
      consume(event);
  };

  const onMouseUp = (event: MouseEvent) => {
    const button = mouseButton(event.button);
    if (button === null) return;
    if (selecting.delete(button)) return;
    if (button === 0 && pendingLeftClick) {
      const pending = pendingLeftClick;
      pendingLeftClick = null;
      lastMotion = "";
      const position = eventPosition(event, canvas, term.cols, term.rows);
      if (!position) return;
      const moved =
        pending.moved ||
        pending.position.cellX !== position.cellX ||
        pending.position.cellY !== position.cellY;
      if (moved) return;
      const protocol = syncMouseTracking();
      if (!protocol) return;
      emitAt(pending.position, protocol, {
        button,
        alt: pending.alt,
        ctrl: pending.ctrl,
      });
      emitAt(position, protocol, {
        button,
        release: true,
        alt: event.altKey || event.metaKey,
        ctrl: event.ctrlKey,
      });
      // Do not consume mouseup: Ghostty must finish its local selection cycle.
      return;
    }
    if (!pressed.delete(button)) return;
    lastMotion = "";
    const protocol = syncMouseTracking();
    if (!protocol) return;
    if (
      emit(event, protocol, {
        button,
        release: true,
        alt: event.altKey || event.metaKey,
        ctrl: event.ctrlKey,
      })
    )
      consume(event);
  };

  const onMouseMove = (event: MouseEvent) => {
    const protocol = syncMouseTracking();
    if (event.shiftKey || selecting.size > 0) return;
    if (pendingLeftClick) {
      const position = eventPosition(event, canvas, term.cols, term.rows);
      if (
        position &&
        (pendingLeftClick.position.cellX !== position.cellX ||
          pendingLeftClick.position.cellY !== position.cellY)
      )
        pendingLeftClick.moved = true;
      return;
    }
    if (!protocol || protocol.tracking === "x10" || protocol.tracking === "vt200") return;
    const button = pressedButton(event.buttons);
    if (protocol.tracking === "drag" && button === 3) return;
    if (button !== 3 && !pressed.has(button)) return;
    const position = eventPosition(event, canvas, term.cols, term.rows);
    if (!position) return;
    const signature = `${button}:${position.cellX}:${position.cellY}:${modifiers(event)}`;
    if (signature === lastMotion) {
      consume(event);
      return;
    }
    lastMotion = signature;
    const data = encodeTerminalMouseReport(protocol, {
      button,
      motion: true,
      alt: event.altKey || event.metaKey,
      ctrl: event.ctrlKey,
      position,
    });
    if (data) {
      if (typeof data === "string") term.input(data, true);
      else emitBinary(data);
      consume(event);
    }
  };

  const onWheel = (event: WheelEvent) => {
    if (event.shiftKey) return false;
    const protocol = syncMouseTracking();
    if (!protocol || protocol.tracking === "x10") {
      wheelAxis = null;
      wheelRemainder = 0;
      return false;
    }
    const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
    const delta = vertical ? event.deltaY : event.deltaX;
    if (!delta) return true;
    const axis = vertical ? "vertical" : "horizontal";
    if (wheelAxis !== axis) {
      wheelAxis = axis;
      wheelRemainder = 0;
    }
    const rect = canvas.getBoundingClientRect();
    const cells = vertical ? term.rows : term.cols;
    const pixels = vertical ? rect.height : rect.width;
    let amount = delta;
    if (event.deltaMode === DOM_DELTA_PIXEL) {
      if (!(pixels > 0) || cells < 1) return true;
      amount /= pixels / cells;
      // 触屏合成的滚轮已经按整行推进，只有高分辨率触控板需要降敏。
      if (Math.abs(delta) < 50 && !isTouchScrollWheel(event)) amount *= 0.3;
    } else if (event.deltaMode === DOM_DELTA_PAGE) {
      amount *= cells;
    }
    const touch = isTouchScrollWheel(event);
    // 触屏桥接传入整行，不混用触控板的余量，也不受浮点换算误差影响。
    wheelRemainder = touch ? 0 : wheelRemainder + amount;
    const steps = touch ? Math.round(amount) : Math.trunc(wheelRemainder);
    if (!touch) wheelRemainder -= steps;
    if (!steps) return true;
    const button = vertical ? (delta < 0 ? 64 : 65) : delta < 0 ? 66 : 67;
    for (let i = 0; i < (touch ? Math.abs(steps) : 1); i++) {
      emit(event, protocol, {
        button,
        alt: event.altKey || event.metaKey,
        ctrl: event.ctrlKey,
      });
    }
    return true;
  };

  container.addEventListener("mousedown", onMouseDown, { capture: true });
  container.addEventListener("mouseenter", syncMouseTracking);
  container.addEventListener("mousemove", onMouseMove, { capture: true });
  container.ownerDocument.addEventListener("mouseup", onMouseUp, { capture: true });
  term.attachCustomWheelEventHandler(onWheel);

  return {
    reset,
    dispose: () => {
      container.removeEventListener("mousedown", onMouseDown, { capture: true });
      container.removeEventListener("mouseenter", syncMouseTracking);
      container.removeEventListener("mousemove", onMouseMove, { capture: true });
      container.ownerDocument.removeEventListener("mouseup", onMouseUp, { capture: true });
      term.attachCustomWheelEventHandler(undefined);
      renderSubscription.dispose();
      container.removeAttribute("data-terminal-mouse-tracking");
      reset();
    },
  };
}
