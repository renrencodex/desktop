interface TerminalGrid {
  readonly cols: number;
  readonly rows: number;
  fit(): void;
}

interface TerminalSizeSyncOptions {
  isActive(): boolean;
  isSelected(): boolean;
  connectedSocket(): WebSocket | null;
  onFit(): void;
  layoutGate?: { isSuspended(): boolean; subscribe(listener: () => void): () => void };
}

/** Sync the measured grid on attach and on entry into the terminal's input focus. */
export function bindTerminalSizeSync(
  container: HTMLElement,
  renderer: TerminalGrid,
  options: TerminalSizeSyncOptions,
) {
  const document = container.ownerDocument;
  const window = document.defaultView!;
  let focused = false;
  let focusRevision = 0;
  let disposed = false;
  let frame: number | undefined;
  let pending: { socket: WebSocket; kind: "opened" | "focus" } | undefined;

  const containsInputFocus = () =>
    options.isActive() &&
    options.isSelected() &&
    !document.hidden &&
    container.contains(document.activeElement);
  const hasInputFocus = () => document.hasFocus() && containsInputFocus();

  const cancelFrame = () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
  };
  const resetConnection = () => {
    cancelFrame();
    pending = undefined;
  };
  const fit = () => {
    if (
      disposed ||
      !options.isActive() ||
      options.layoutGate?.isSuspended() ||
      !container.clientWidth ||
      !container.clientHeight
    )
      return;
    try {
      renderer.fit();
      options.onFit();
    } catch {
      // A hidden or transitioning surface may not have usable cell measurements yet.
      return;
    }

    const socket = options.connectedSocket();
    if (!socket || pending?.socket !== socket) return;
    const claimSize = hasInputFocus();
    if (pending.kind === "opened" || claimSize) {
      resetConnection();
      socket.send(
        JSON.stringify({ type: "resize", cols: renderer.cols, rows: renderer.rows, claimSize }),
      );
    }
  };
  const requestClaim = () => {
    const socket = options.connectedSocket();
    if (!socket) return;
    if (pending?.socket !== socket) {
      resetConnection();
      pending = { socket, kind: "focus" };
    }
    if (frame !== undefined) return;
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      if (pending?.socket !== socket || options.connectedSocket() !== socket) return;
      if (hasInputFocus()) fit();
    });
  };
  const setFocused = (next: boolean) => {
    if (next === focused) return;
    focused = next;
    if (next) requestClaim();
    else if (pending?.kind === "focus") resetConnection();
    else cancelFrame();
  };
  const syncFocus = () => {
    focusRevision++;
    setFocused(hasInputFocus());
  };
  const onFocusOut = (event: FocusEvent) => {
    const revision = ++focusRevision;
    if (event.relatedTarget instanceof window.Node) {
      if (!container.contains(event.relatedTarget)) setFocused(false);
      return;
    }
    // Ghostty redirects host focus to its textarea inside the same task.
    window.queueMicrotask(() => {
      if (!disposed && revision === focusRevision) setFocused(hasInputFocus());
    });
  };
  const onWindowFocus = () => {
    focusRevision++;
    // The claim's animation frame validates document.hasFocus() after window activation.
    setFocused(containsInputFocus());
  };
  const onWindowBlur = () => {
    focusRevision++;
    setFocused(false);
  };

  container.addEventListener("focusin", syncFocus);
  container.addEventListener("focusout", onFocusOut);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("visibilitychange", syncFocus);
  const stopLayout = options.layoutGate?.subscribe(() => {
    if (!options.layoutGate?.isSuspended() && hasInputFocus()) requestClaim();
  });
  syncFocus();

  return {
    fit,
    syncFocus,
    resetConnection,
    opened() {
      const socket = options.connectedSocket();
      if (!socket) return;
      resetConnection();
      pending = { socket, kind: "opened" };
      fit();
    },
    dispose() {
      disposed = true;
      resetConnection();
      stopLayout?.();
      container.removeEventListener("focusin", syncFocus);
      container.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", syncFocus);
    },
  };
}
