/** Hide the browser caret used for IME and keep abspos inputs inside the renderer. */
export function concealTerminalNativeCaret(container: HTMLElement) {
  container.style.caretColor = "transparent";
  const position = container.ownerDocument.defaultView?.getComputedStyle(container).position;
  if (!position || position === "static") container.style.position = "relative";
  for (const input of container.querySelectorAll<HTMLElement>("textarea, input")) {
    input.style.caretColor = "transparent";
  }
}

/**
 * Keep IME composition inside the renderer's native input. Focusing the
 * contenteditable canvas host lets browsers create a DOM caret after the
 * full-height canvas and scroll the whole workbench to reveal it.
 */
export function focusTerminalNativeInput(container: HTMLElement, input?: HTMLElement) {
  (input ?? container).focus({ preventScroll: true });
}

/** Place the invisible IME input over the terminal's painted cursor cell. */
export function positionTerminalNativeInput(
  container: HTMLElement,
  input: HTMLElement,
  cursor: { column: number; row: number; cellWidth: number; cellHeight: number },
) {
  applyNativeInputPosition(input, cursor, container.clientWidth, container.clientHeight);
}

interface NativeInputCursor {
  column: number;
  row: number;
  cellWidth: number;
  cellHeight: number;
}

function applyNativeInputPosition(
  input: HTMLElement,
  cursor: NativeInputCursor,
  width: number,
  height: number,
) {
  if (!(cursor.cellWidth > 0) || !(cursor.cellHeight > 0)) return;
  const left = Math.max(
    0,
    Math.min(cursor.column * cursor.cellWidth, Math.max(0, width - cursor.cellWidth)),
  );
  const top = Math.max(
    0,
    Math.min(cursor.row * cursor.cellHeight, Math.max(0, height - cursor.cellHeight)),
  );
  const styles = {
    left: `${left}px`,
    top: `${top}px`,
    width: `${cursor.cellWidth}px`,
    height: `${cursor.cellHeight}px`,
    lineHeight: `${cursor.cellHeight}px`,
  };
  for (const key of Object.keys(styles) as Array<keyof typeof styles>) {
    if (input.style[key] !== styles[key]) input.style[key] = styles[key];
  }
}

/** Batch only IME geometry, never terminal parsing or keyboard delivery. */
export function createTerminalNativeInputPositioner(
  container: HTMLElement,
  getInput: () => HTMLElement | undefined,
  getCursor: () => NativeInputCursor | undefined,
) {
  const window = container.ownerDocument.defaultView!;
  let visible = true;
  let disposed = false;
  let frame = 0;
  let measure = true;
  let width = 0;
  let height = 0;
  const cancel = () => {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
  };
  const flush = () => {
    cancel();
    if (disposed || !visible || container.ownerDocument.hidden) return;
    const input = getInput();
    const cursor = getCursor();
    if (!input || !cursor) return;
    if (measure) {
      width = container.clientWidth;
      height = container.clientHeight;
      measure = false;
    }
    applyNativeInputPosition(input, cursor, width, height);
  };
  const schedule = () => {
    if (!disposed && visible && !container.ownerDocument.hidden && !frame)
      frame = window.requestAnimationFrame(flush);
  };
  const refresh = () => {
    measure = true;
    flush();
  };
  const observer = new window.ResizeObserver(() => {
    measure = true;
    schedule();
  });
  observer.observe(container);
  // Capture before the native textarea's composition adapter stops propagation.
  container.addEventListener("compositionstart", refresh, true);
  return {
    schedule,
    refresh,
    cancel,
    setVisible(value: boolean) {
      if (visible === value) return;
      visible = value;
      if (value) refresh();
      else cancel();
    },
    dispose() {
      disposed = true;
      cancel();
      observer.disconnect();
      container.removeEventListener("compositionstart", refresh, true);
    },
  };
}

/** Redirect browser-default focus on the contenteditable host back to its IME input. */
export function bindTerminalNativeInputFocus(
  container: HTMLElement,
  getInput: () => HTMLElement | undefined,
  beforeFocus?: () => void,
) {
  const focus = () => {
    beforeFocus?.();
    focusTerminalNativeInput(container, getInput());
  };
  const redirectHostFocus = () => {
    const input = getInput();
    if (input && container.ownerDocument.activeElement === container) {
      focus();
    }
  };
  container.addEventListener("focus", redirectHostFocus);
  return {
    focus,
    dispose: () => container.removeEventListener("focus", redirectHostFocus),
  };
}

/** Keep renderer cursor animation in sync with both Pane selection and real DOM focus. */
export function bindTerminalFocus(
  container: HTMLElement,
  target: { focus(): void; setCursorBlink(value: boolean): void },
) {
  const document = container.ownerDocument;
  const window = document.defaultView!;
  let enabled = false;
  let readOnly = true;
  let disposed = false;
  let blinking: boolean | undefined;
  const sync = () => {
    if (disposed) return;
    const next =
      enabled &&
      !readOnly &&
      !document.hidden &&
      document.hasFocus() &&
      container.contains(document.activeElement);
    if (next === blinking) return;
    blinking = next;
    target.setCursorBlink(next);
    container.dataset.terminalCursorBlink = String(next);
  };
  const blur = () => {
    const element = document.activeElement;
    if (element instanceof window.HTMLElement && container.contains(element)) element.blur();
  };
  container.addEventListener("focusin", sync);
  container.addEventListener("focusout", sync);
  window.addEventListener("focus", sync);
  const onWindowBlur = () => {
    // hasFocus() may still report true while the window blur event is being dispatched.
    if (disposed) return;
    blinking = false;
    target.setCursorBlink(false);
    container.dataset.terminalCursorBlink = "false";
  };
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("visibilitychange", sync);
  sync();
  return {
    setFocused(value: boolean) {
      if (disposed) return;
      enabled = value;
      if (!value) blur();
      sync();
    },
    setReadOnly(value: boolean) {
      readOnly = value;
      sync();
    },
    focus() {
      if (!disposed && enabled) target.focus();
      sync();
    },
    dispose() {
      disposed = true;
      target.setCursorBlink(false);
      container.removeEventListener("focusin", sync);
      container.removeEventListener("focusout", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", sync);
      delete container.dataset.terminalCursorBlink;
    },
  };
}
