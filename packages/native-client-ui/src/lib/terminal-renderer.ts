import type { ITheme as XtermTheme, Terminal as XtermTerminal } from "@xterm/xterm";
import { bindGhosttyCanvasPaint } from "@cloud-machine/workspace-ui/terminal-canvas-paint";
import {
  installGhosttyBackgroundPixelAlignment,
  installGhosttySelectionAutoScrollBoundary,
} from "@cloud-machine/workspace-ui/terminal-canvas-selection";
import { createTerminalOsc52Filter } from "@cloud-machine/workspace-ui/terminal-osc52";

import "@xterm/xterm/css/xterm.css";

import {
  bindTerminalKeyboard,
  cursorKeySequence,
  terminalHistoryPageOffset,
  type TerminalTouchKey,
} from "./terminal-keybindings";
import {
  bindTerminalNativeInputFocus,
  bindTerminalFocus,
  concealTerminalNativeCaret,
  createTerminalNativeInputPositioner,
} from "./terminal-focus";
import { repairTerminalCanvas } from "./terminal-canvas-recovery";
import { applyTerminalGridFit } from "./terminal-fit";
import { attachGhosttyMouseReporting } from "./terminal-mouse";
import { bindTerminalNativeInput } from "./terminal-native-input";
import { bindNormalizedTerminalPaste, normalizeTerminalPaste } from "./terminal-paste";
import { anchoredViewportY } from "./terminal-scroll";
import { bindTerminalSoftKeyboard } from "./terminal-soft-keyboard";
import { attachTerminalTouchScroll } from "./terminal-touch";
import {
  createTerminalTouchSelection,
  terminalSelectionText,
  type TerminalSelectionBuffer,
  type TerminalSelectionLine,
} from "./terminal-touch-selection";
import { bindTerminalUserInputIntent } from "./terminal-user-input";
import { PHONE_MEDIA_QUERY } from "./responsive";

export interface TerminalRendererScrollState {
  /** Lines between the viewport and live output; zero follows the bottom. */
  offsetLines: number;
  historyLines: number;
  viewportRows: number;
  alternateScreen: boolean;
}

export interface TerminalRenderer {
  readonly backend: "ghostty" | "xterm";
  sendKey(key: TerminalTouchKey, shifted?: boolean): void;
  readonly cols: number;
  readonly rows: number;
  /** Invoked after parsing, including asynchronous xterm writes. */
  write(data: string | Uint8Array, onParsed?: () => void): void;
  reset(): void;
  focus(): void;
  setFocused(value: boolean): void;
  setVisible(value: boolean): void;
  paste(data: string): void;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  isTouchSelectionActive(): boolean;
  armTouchSelection(): void;
  isTouchSelectionArmed(): boolean;
  getTouchSelectionAnchor(): { x: number; y: number } | null;
  fit(): void;
  cancelScroll(): void;
  scrollToBottom(): void;
  isAtBottom(): boolean;
  getScrollState(): TerminalRendererScrollState;
  scrollToOffset(offsetLines: number): void;
  setFontFamily(value: string): void;
  setFontSize(value: number): void;
  setReadOnly(value: boolean): void;
  /** 触屏设备默认禁止软键盘；只有显式请求键盘时才放开（桌面无副作用）。 */
  setSoftKeyboardAllowed(value: boolean): void;
  /** DECCKM：应用光标键模式下方向键必须用 SS3 序列。 */
  applicationCursorKeys(): boolean;
  onData(listener: (data: string) => void): { dispose(): void };
  onBinary(listener: (data: Uint8Array) => void): { dispose(): void };
  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void };
  onScroll(listener: () => void): { dispose(): void };
  onSelectionChange(listener: () => void): { dispose(): void };
  dispose(): void;
}

let ghosttyPromise: Promise<import("ghostty-web").Ghostty> | null = null;

async function loadGhostty(): Promise<import("ghostty-web").Ghostty> {
  const { Ghostty } = await import("ghostty-web");
  ghosttyPromise ??= Ghostty.load("/wasm/ghostty-vt-0.4.0.wasm");
  return ghosttyPromise;
}

/** 登录后后台预热 ghostty-wasm 与其 JS chunk，终端首开不再等待下载编译。 */
export function prewarmTerminalRenderer(): void {
  if (typeof document !== "undefined" && document.fonts)
    void document.fonts.load('14px "Iosevka Term"').catch(() => {});
  void loadGhostty().catch(() => {
    // 预热失败（如离线）不应毒化缓存，让真正的首开走完整加载与回退逻辑。
    ghosttyPromise = null;
  });
}

export interface TerminalKeyboardHost {
  copy(): void;
  paste(): void;
  /** Omit for local/rescue history. Persistent sessions must supply authoritative state. */
  history?: {
    alternateScreen(): boolean | null;
    page(pages: -1 | 1): void;
  };
}

interface TerminalRendererOptions {
  visible?: boolean;
  isPhoneApplication?: () => boolean;
  isLiveCursorApplication?: () => boolean;
  /** Desktop can suspend geometry while its native window is minimized/restoring. */
  layoutGate?: {
    isSuspended(): boolean;
    subscribe(listener: () => void): () => void;
  };
  fontFamily: string;
  fontSize: number;
  theme: XtermTheme;
  backend?: "auto" | "xterm";
  onBlankLongPress?: (point: { x: number; y: number }) => void;
  onClipboardWrite?: (text: string) => void | Promise<void>;
  keyboardHost: TerminalKeyboardHost;
}

type TerminalSurface = Omit<TerminalRenderer, "sendKey"> & { input(data: string): void };

export async function createTerminalRenderer(
  container: HTMLElement,
  options: TerminalRendererOptions,
  signal?: AbortSignal,
): Promise<TerminalRenderer> {
  const surface = await createBackendRenderer(container, options, signal);
  const document = container.ownerDocument;
  let paneVisible = options.visible !== false;
  let visible: boolean | undefined;
  const setSurfaceVisible = surface.setVisible;
  const setFontFamily = surface.setFontFamily;
  const setFontSize = surface.setFontSize;
  let pendingFamily: string | undefined;
  let pendingSize: number | undefined;
  const syncVisibility = () => {
    const next = paneVisible && !document.hidden && !options.layoutGate?.isSuspended();
    if (next === visible) return;
    visible = next;
    if (next) {
      if (pendingFamily !== undefined) {
        setFontFamily(pendingFamily);
        pendingFamily = undefined;
      }
      if (pendingSize !== undefined) {
        setFontSize(pendingSize);
        pendingSize = undefined;
      }
      if (container.clientWidth && container.clientHeight) surface.fit();
    }
    setSurfaceVisible(next);
  };
  document.addEventListener("visibilitychange", syncVisibility);
  const stopLayout = options.layoutGate?.subscribe(syncVisibility);
  syncVisibility();
  let readOnly = false;
  const keyboard = bindTerminalKeyboard(container, {
    context: () => ({
      mac: /Mac|iPhone|iPad/.test(container.ownerDocument.defaultView?.navigator.platform ?? ""),
      hasSelection: surface.hasSelection(),
      applicationCursorKeys: surface.applicationCursorKeys(),
      alternateScreen: options.keyboardHost.history
        ? options.keyboardHost.history.alternateScreen()
        : surface.getScrollState().alternateScreen,
    }),
    isReadOnly: () => readOnly,
    send: (data) => {
      surface.cancelScroll();
      surface.input(data);
    },
    copy: () => options.keyboardHost.copy(),
    paste: () => options.keyboardHost.paste(),
    history: (pages) => {
      if (options.keyboardHost.history) options.keyboardHost.history.page(pages);
      else surface.scrollToOffset(terminalHistoryPageOffset(surface.getScrollState(), pages));
    },
  });
  const nativePaste = bindNormalizedTerminalPaste(container, {
    isReadOnly: () => readOnly,
    paste: (data) => surface.paste(data),
  });
  const setReadOnly = surface.setReadOnly;
  const dispose = surface.dispose;
  return Object.assign(surface, {
    setFontFamily: (value: string) => {
      if (options.layoutGate?.isSuspended()) pendingFamily = value;
      else {
        pendingFamily = undefined;
        setFontFamily(value);
      }
    },
    setFontSize: (value: number) => {
      if (options.layoutGate?.isSuspended()) pendingSize = value;
      else {
        pendingSize = undefined;
        setFontSize(value);
      }
    },
    setVisible: (value: boolean) => {
      paneVisible = value;
      syncVisibility();
    },
    sendKey: (key: TerminalTouchKey, shifted = false) => keyboard.sendKey(key, shifted),
    setReadOnly: (value: boolean) => {
      readOnly = value;
      setReadOnly(value);
    },
    dispose: () => {
      stopLayout?.();
      document.removeEventListener("visibilitychange", syncVisibility);
      keyboard.dispose();
      nativePaste.dispose();
      dispose();
    },
  });
}

async function createBackendRenderer(
  container: HTMLElement,
  options: TerminalRendererOptions,
  signal?: AbortSignal,
): Promise<TerminalSurface> {
  if (options.backend === "xterm") return createXtermRenderer(container, options, signal);
  try {
    const [{ Terminal, FitAddon }, ghostty] = await Promise.all([
      import("ghostty-web"),
      loadGhostty(),
    ]);
    // A stale asynchronous initialization must not open into a container now
    // owned by a newer effect (including React Strict Mode's remount).
    signal?.throwIfAborted();
    const term = new Terminal({
      ghostty,
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      theme: options.theme,
      cursorBlink: false,
      scrollback: 10_000,
      smoothScrollDuration: 0,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const osc52 = createTerminalOsc52Filter(options.onClipboardWrite);
    const currentTheme = options.theme;
    const setCursorActive = (value: boolean) => {
      term.options.cursorBlink = value;
      // Ghostty 0.4.0 keeps a solid cursor when blinking stops. Its terminal
      // theme setter is not implemented, so update the public canvas renderer
      // and repaint to erase the old cursor without changing the PTY's modes.
      term.renderer?.setTheme(value ? currentTheme : { ...currentTheme, cursor: "transparent" });
      if (term.renderer && term.wasmTerm)
        term.renderer.render(term.wasmTerm, true, term.getViewportY(), term, 0);
    };
    let renderVisible =
      options.visible !== false &&
      !container.ownerDocument.hidden &&
      !options.layoutGate?.isSuspended();
    const inputPosition = createTerminalNativeInputPositioner(
      container,
      () => term.textarea,
      () => {
        const metrics = term.renderer?.getMetrics();
        if (!metrics) return;
        return {
          column: term.buffer.active.cursorX,
          row: term.buffer.active.cursorY,
          cellWidth: metrics.width,
          cellHeight: metrics.height,
        };
      },
    );
    inputPosition.setVisible(renderVisible);
    const syncNativeInputPosition = inputPosition.refresh;
    // Ghostty 0.4.0 open() calls focus(), which also queues an unconditional
    // second focus. Pane selection, not renderer initialization, owns focus.
    const nativeInputFocus = bindTerminalNativeInputFocus(
      container,
      () => term.textarea,
      syncNativeInputPosition,
    );
    const focus = bindTerminalFocus(container, {
      // Ghostty's canvas host is contenteditable, but its hidden textarea is
      // the safe target for IME composition. Events still bubble to the host's
      // input handler without introducing a DOM caret after the canvas.
      focus: nativeInputFocus.focus,
      setCursorBlink: setCursorActive,
    });
    term.focus = focus.focus;
    let softKeyboard: ReturnType<typeof bindTerminalSoftKeyboard> | null = null;
    let stopBackgroundPixelAlignment: (() => void) | undefined;
    let stopSelectionAutoScrollBoundary: (() => void) | undefined;
    let canvasPaint: ReturnType<typeof bindGhosttyCanvasPaint> | undefined;
    try {
      term.open(container);
      stopSelectionAutoScrollBoundary = installGhosttySelectionAutoScrollBoundary(term);
      stopBackgroundPixelAlignment = installGhosttyBackgroundPixelAlignment(term.renderer);
      canvasPaint = bindGhosttyCanvasPaint(term, container, {
        isVisible: () => renderVisible && !container.ownerDocument.hidden,
        isPhoneApplication: options.isPhoneApplication,
        isLiveCursorApplication: options.isLiveCursorApplication,
      });
      concealTerminalNativeCaret(container);
      setCursorActive(false);
      // open() 之后宿主才是 contenteditable、textarea 才存在。
      softKeyboard = bindTerminalSoftKeyboard(container, () => term.textarea);
    } catch (error) {
      stopSelectionAutoScrollBoundary?.();
      stopBackgroundPixelAlignment?.();
      canvasPaint?.dispose();
      softKeyboard?.dispose();
      nativeInputFocus.dispose();
      focus.dispose();
      inputPosition.dispose();
      term.dispose();
      throw error;
    }
    const softKeyboardGate = softKeyboard;
    const nativeInput = bindTerminalNativeInput(term.textarea!, {
      isReadOnly: () => term.options.disableStdin === true,
      send: (data) => term.input(data, true),
    });
    const binaryListeners = new Set<(data: Uint8Array) => void>();
    const cursorSubscription = term.onCursorMove(inputPosition.schedule);
    const scrollSubscription = term.onScroll(inputPosition.schedule);
    const canvas = term.renderer?.getCanvas();
    const document = container.ownerDocument;
    const window = document.defaultView;
    const repairCanvasScale = (force = false) => {
      const renderer = term.renderer;
      const buffer = term.wasmTerm;
      if (!renderVisible || !renderer || !buffer || !canvas || !container.isConnected) return false;
      const metrics = renderer.getMetrics();
      return repairTerminalCanvas(
        canvas,
        term.cols,
        metrics.width,
        () => {
          renderer.resize(term.cols, term.rows);
          renderer.render(buffer, true, term.getViewportY(), term, 0);
          syncNativeInputPosition();
        },
        force,
      );
    };
    const onContextRestored = () => repairCanvasScale(true);
    const onForeground = () => {
      if (!document.hidden) repairCanvasScale();
    };
    canvas?.addEventListener("contextrestored", onContextRestored);
    document.addEventListener("visibilitychange", onForeground);
    window?.addEventListener("focus", onForeground);
    window?.addEventListener("pageshow", onForeground);
    const canvasCheckTimer = window?.setInterval(() => {
      if (
        !document.hidden &&
        container.getClientRects().length > 0 &&
        window.matchMedia?.(PHONE_MEDIA_QUERY).matches
      )
        repairCanvasScale();
    }, 5_000);
    const mouse = attachGhosttyMouseReporting(term, container, (data) => {
      for (const listener of binaryListeners) listener(data);
    });
    const selectionBuffer: TerminalSelectionBuffer = {
      get cols() {
        return term.cols;
      },
      get rows() {
        return term.rows;
      },
      getViewportTop: () =>
        Math.max(0, term.buffer.active.length - term.rows - Math.floor(term.getViewportY())),
      getBufferLength: () => term.buffer.active.length,
      getLine: (row) => term.buffer.active.getLine(row) as TerminalSelectionLine | undefined,
      wrapsToNext: (row) => term.buffer.active.getLine(row)?.isWrapped === true,
      getSurface: () => canvas ?? null,
      scrollLines: (lines) => {
        const before = term.getViewportY();
        term.scrollLines(lines);
        return before !== term.getViewportY();
      },
    };
    const selectionManager = (
      term as unknown as {
        selectionManager?: {
          wasmTerm: unknown;
          selectionStart: { col: number; absoluteRow: number } | null;
          selectionEnd: { col: number; absoluteRow: number } | null;
          isSelecting: boolean;
          mouseDownTarget: EventTarget | null;
          stopAutoScroll(): void;
          deselect(): void;
          getSelection(): string;
        };
      }
    ).selectionManager;
    if (selectionManager) {
      // ghostty-web 0.4.0 serializes every codepoint=0 cell as a space, including
      // the continuation cell of a width-2 glyph. Read the public buffer instead,
      // where width=0 can be distinguished from a real blank cell.
      selectionManager.getSelection = () => {
        const start = selectionManager.selectionStart;
        const end = selectionManager.selectionEnd;
        if (!start || !end || (start.col === end.col && start.absoluteRow === end.absoluteRow))
          return "";
        return terminalSelectionText(selectionBuffer, {
          start: { column: start.col, row: start.absoluteRow },
          end: { column: end.col, row: end.absoluteRow },
        });
      };
    }
    const touchSelection = createTerminalTouchSelection(
      container,
      selectionBuffer,
      options.theme.selectionBackground ?? "#214283",
      {
        background: options.theme.background,
        foreground: options.theme.foreground,
        fontFamily: () => term.options.fontFamily ?? options.fontFamily,
      },
    );
    const touch = attachTerminalTouchScroll(
      container,
      () => (term.renderer?.getCanvas().getBoundingClientRect().height ?? 0) / term.rows,
      {
        getMode: () =>
          `${term.wasmTerm?.isAlternateScreen()}:${[1, 9, 1000, 1002, 1003, 1006, 1016].map((mode) => term.getMode(mode)).join(":")}:${term.options.disableStdin}`,
        scroll: (lines) => {
          // X10 仅支持按下事件，没有滚轮能力，备用屏幕仍走光标键。
          const tracksWheel = [1000, 1002, 1003].some((mode) => term.getMode(mode));
          if (term.options.disableStdin || !tracksWheel) {
            if (term.wasmTerm?.isAlternateScreen() && !term.options.disableStdin) {
              term.input(
                cursorKeySequence(lines < 0 ? "up" : "down", term.getMode(1)).repeat(
                  Math.abs(lines),
                ),
                true,
              );
              return true;
            }
            const before = term.getViewportY();
            term.scrollLines(lines);
            return before !== term.getViewportY();
          }
          return undefined;
        },
        selection: {
          isActive: touchSelection.isActive,
          isRangeSelectionArmed: touchSelection.isRangeSelectionArmed,
          beginHandleDrag: touchSelection.beginHandleDrag,
          begin: (point) => {
            term.clearSelection();
            return touchSelection.begin(point);
          },
          beginRange: touchSelection.beginRange,
          update: touchSelection.update,
          end: touchSelection.end,
          clear: touchSelection.clear,
        },
        onBlankLongPress: options.onBlankLongPress,
      },
    );
    const userInputIntent = bindTerminalUserInputIntent(container);
    // 只有键盘/输入法产生的数据才代表用户回到当前会话。TUI 的焦点上报、设备查询等
    // 协议响应同样经过 onData，不能因此清除正在拖动的手机选区。
    const followOnInput = term.onData(() => {
      if (!userInputIntent.isCurrent()) return;
      touchSelection.clear();
      term.scrollToBottom();
    });
    const selectionScrollSubscription = term.onScroll(() => touchSelection.refresh());
    const write = (data: string | Uint8Array) => {
      const viewportY = term.getViewportY();
      if (viewportY <= 0 || term.wasmTerm?.isAlternateScreen()) {
        term.write(data);
        return;
      }
      // write() 内部会 scrollToBottom()，写完按新的 scrollback 长度回到原来的历史位置。
      const before = { viewportY, scrollbackLength: term.getScrollbackLength() };
      term.write(data);
      const delta = anchoredViewportY(before, term.getScrollbackLength()) - term.getViewportY();
      if (delta) term.scrollLines(-delta);
    };
    const pasteNormalized = (data: string) => {
      touchSelection.clear();
      touch.cancel();
      term.paste(data);
    };
    return {
      backend: "ghostty",
      input: (data) => {
        touchSelection.clear();
        term.scrollToBottom();
        term.input(data, true);
      },
      get cols() {
        return term.cols;
      },
      get rows() {
        return term.rows;
      },
      write: (data, onParsed) => {
        const filtered = osc52.push(data);
        // Ghostty 0.4.0's WASM allocator rejects zero-length buffers. An empty
        // snapshot is still a completed write, just without parser work.
        if (filtered.length > 0) {
          write(filtered);
          canvasPaint.outputParsed(filtered);
        }
        inputPosition.schedule();
        onParsed?.();
      },
      reset: () => {
        canvasPaint.reset();
        inputPosition.cancel();
        osc52.reset();
        touchSelection.clear();
        touch.cancel();
        nativeInput.reset();
        mouse.reset();
        // Ghostty 0.4.0 replaces wasmTerm on reset but leaves its selection manager
        // holding the freed buffer (and old grid size). Rebind the existing manager
        // rather than recreate its DOM listeners. Recheck this shim on upgrades.
        const selection = selectionManager;
        term.clearSelection();
        if (selection) {
          // clearSelection() returns early for a mouse-down anchor with no range.
          // Cancel that gesture too, before a new snapshot replaces its contents.
          selection.stopAutoScroll();
          selection.isSelecting = false;
          selection.selectionStart = null;
          selection.selectionEnd = null;
          selection.mouseDownTarget = null;
        }
        term.reset();
        if (selection) {
          selection.wasmTerm = term.wasmTerm;
          selection.deselect();
        }
        term.scrollToBottom();
        syncNativeInputPosition();
      },
      focus: focus.focus,
      setVisible: (value) => {
        renderVisible = value;
        inputPosition.setVisible(value);
        if (!value) {
          canvasPaint.cancelRmuxRepaint();
          touch.cancel();
        }
        // fit() runs before visibility is enabled, so its scale repair is skipped.
        // Restore any context state lost in the background before the first paint.
        else if (!repairCanvasScale() && term.renderer && term.wasmTerm)
          term.renderer.render(term.wasmTerm, true, term.getViewportY(), term, 0);
      },
      setFocused: (value) => {
        if (!value) touchSelection.clear();
        touch.setEnabled(value);
        focus.setFocused(value);
      },
      paste: (data) => {
        pasteNormalized(normalizeTerminalPaste(data));
      },
      hasSelection: () => touchSelection.hasSelection() || term.hasSelection(),
      getSelection: () =>
        touchSelection.isActive() ? touchSelection.getSelection() : term.getSelection(),
      clearSelection: () => {
        touchSelection.clear();
        term.clearSelection();
      },
      isTouchSelectionActive: touchSelection.isActive,
      armTouchSelection: touchSelection.armRangeSelection,
      isTouchSelectionArmed: touchSelection.isRangeSelectionArmed,
      getTouchSelectionAnchor: touchSelection.getActionAnchor,
      fit: () => {
        if (options.layoutGate?.isSuspended()) return;
        const before = { cols: term.cols, rows: term.rows };
        // Ghostty FitAddon always subtracts 15px for an overlay scrollbar, which
        // leaves a TUI gutter. Size the grid to the container content box instead.
        if (
          !applyTerminalGridFit(container, term.renderer?.getMetrics(), term, (cols, rows) =>
            term.resize(cols, rows),
          )
        )
          fit.fit();
        if (before.cols !== term.cols) {
          touchSelection.clear();
          touch.cancel();
        } else {
          if (before.rows !== term.rows && !touchSelection.isActive()) touch.cancel();
          touchSelection.refresh();
        }
        repairCanvasScale();
        syncNativeInputPosition();
      },
      cancelScroll: () => {
        touchSelection.clear();
        touch.cancel();
      },
      scrollToBottom: () => {
        touchSelection.clear();
        touch.cancel();
        term.scrollToBottom();
      },
      isAtBottom: () => term.getViewportY() <= 0,
      getScrollState: () => {
        const historyLines = term.getScrollbackLength();
        return {
          offsetLines: Math.max(0, Math.min(historyLines, Math.floor(term.getViewportY()))),
          historyLines,
          viewportRows: term.rows,
          alternateScreen: term.wasmTerm?.isAlternateScreen() === true,
        };
      },
      scrollToOffset: (offsetLines) => {
        touchSelection.clear();
        touch.cancel();
        const historyLines = term.getScrollbackLength();
        term.scrollToLine(Math.max(0, Math.min(historyLines, Math.round(offsetLines))));
      },
      setFontFamily: (value) => {
        touchSelection.clear();
        touch.cancel();
        term.options.fontFamily = value;
        repairCanvasScale();
        inputPosition.refresh();
      },
      setFontSize: (value) => {
        touchSelection.clear();
        touch.cancel();
        term.options.fontSize = value;
        repairCanvasScale();
        inputPosition.refresh();
      },
      setReadOnly: (value) => {
        if (term.options.disableStdin !== value) touch.cancel();
        if (value) nativeInput.reset();
        term.options.disableStdin = value;
        focus.setReadOnly(value);
      },
      setSoftKeyboardAllowed: (value) => {
        if (!touchSelection.isActive()) touch.cancel();
        softKeyboardGate.setAllowed(value);
      },
      applicationCursorKeys: () => {
        try {
          return term.getMode(1);
        } catch {
          // 重连或 reset 期间 wasm 终端可能不可用，按普通光标键处理。
          return false;
        }
      },
      onData: (listener) => term.onData(listener),
      onBinary: (listener) => {
        binaryListeners.add(listener);
        return { dispose: () => binaryListeners.delete(listener) };
      },
      onResize: (listener) => term.onResize(listener),
      onScroll: (listener) => term.onScroll(listener),
      onSelectionChange: (listener) => {
        const native = term.onSelectionChange(listener);
        const touchSelectionChange = touchSelection.onChange(listener);
        return {
          dispose: () => {
            native.dispose();
            touchSelectionChange.dispose();
          },
        };
      },
      dispose: () => {
        inputPosition.dispose();
        canvas?.removeEventListener("contextrestored", onContextRestored);
        document.removeEventListener("visibilitychange", onForeground);
        window?.removeEventListener("focus", onForeground);
        window?.removeEventListener("pageshow", onForeground);
        if (canvasCheckTimer !== undefined) window?.clearInterval(canvasCheckTimer);
        nativeInput.dispose();
        mouse.dispose();
        touch.dispose();
        touchSelection.dispose();
        userInputIntent.dispose();
        followOnInput.dispose();
        selectionScrollSubscription.dispose();
        cursorSubscription.dispose();
        scrollSubscription.dispose();
        binaryListeners.clear();
        softKeyboardGate.dispose();
        nativeInputFocus.dispose();
        focus.dispose();
        stopSelectionAutoScrollBoundary?.();
        stopBackgroundPixelAlignment?.();
        canvasPaint.dispose();
        term.dispose();
      },
    };
  } catch (ghosttyError) {
    signal?.throwIfAborted();
    console.warn("Ghostty Web 初始化失败，已回退到 xterm.js", ghosttyError);
    return createXtermRenderer(container, options, signal);
  }
}

async function createXtermRenderer(
  container: HTMLElement,
  options: TerminalRendererOptions,
  signal?: AbortSignal,
): Promise<TerminalSurface> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  signal?.throwIfAborted();
  const term = new Terminal({
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    theme: options.theme,
    cursorBlink: false,
    cursorInactiveStyle: "none",
    scrollback: 10_000,
  });
  const osc52 = createTerminalOsc52Filter(options.onClipboardWrite);
  let disposed = false;
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  concealTerminalNativeCaret(container);
  const focus = bindTerminalFocus(container, {
    focus: () => term.focus(),
    setCursorBlink: (value) => {
      term.options.cursorBlink = value;
    },
  });
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
  const touchSelection = createTerminalTouchSelection(
    container,
    {
      get cols() {
        return term.cols;
      },
      get rows() {
        return term.rows;
      },
      getViewportTop: () => term.buffer.active.viewportY,
      getBufferLength: () => term.buffer.active.length,
      getLine: (row) => term.buffer.active.getLine(row) as TerminalSelectionLine | undefined,
      wrapsToNext: (row) => term.buffer.active.getLine(row + 1)?.isWrapped === true,
      getSurface: () => screen,
      scrollLines: (lines) => {
        const before = term.buffer.active.viewportY;
        term.scrollLines(lines);
        return before !== term.buffer.active.viewportY;
      },
    },
    options.theme.selectionBackground ?? "#214283",
    {
      background: options.theme.background,
      foreground: options.theme.foreground,
      fontFamily: () => term.options.fontFamily ?? options.fontFamily,
    },
  );
  // xterm.js 的 viewport 在移动端也不接受触屏拖动（canvas 铺满 pane，没有可滚动内容）。
  const touch = attachTerminalTouchScroll(
    container,
    () =>
      (term.element?.querySelector(".xterm-screen")?.getBoundingClientRect().height ?? 0) /
      term.rows,
    {
      singleLineWheel: true,
      getMode: () =>
        `${term.buffer.active.type}:${term.modes.mouseTrackingMode}:${term.modes.applicationCursorKeysMode}:${term.options.disableStdin}`,
      scroll: (lines) => {
        if (term.options.disableStdin || ["none", "x10"].includes(term.modes.mouseTrackingMode)) {
          if (term.buffer.active.type === "alternate" && !term.options.disableStdin) {
            term.input(
              cursorKeySequence(
                lines < 0 ? "up" : "down",
                term.modes.applicationCursorKeysMode,
              ).repeat(Math.abs(lines)),
              true,
            );
            return true;
          }
          const before = term.buffer.active.viewportY;
          term.scrollLines(lines);
          return before !== term.buffer.active.viewportY;
        }
        return undefined;
      },
      selection: {
        isActive: touchSelection.isActive,
        isRangeSelectionArmed: touchSelection.isRangeSelectionArmed,
        beginHandleDrag: touchSelection.beginHandleDrag,
        begin: (point) => {
          term.clearSelection();
          return touchSelection.begin(point);
        },
        beginRange: touchSelection.beginRange,
        update: touchSelection.update,
        end: touchSelection.end,
        clear: touchSelection.clear,
      },
      onBlankLongPress: options.onBlankLongPress,
    },
  );
  const userInputIntent = bindTerminalUserInputIntent(container);
  const softKeyboard = bindTerminalSoftKeyboard(container, () => term.textarea);
  const selectionScrollSubscription = term.onScroll(() => touchSelection.refresh());
  const clearSelectionOnInput = term.onData(() => {
    if (userInputIntent.isCurrent()) touchSelection.clear();
  });
  return {
    backend: "xterm",
    input: (data) => {
      touchSelection.clear();
      term.input(data, true);
    },
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write: (data, onParsed) => {
      const filtered = osc52.push(data);
      term.write(filtered.length > 0 ? filtered : "", onParsed);
    },
    reset: () => {
      osc52.reset();
      touchSelection.clear();
      touch.cancel();
      // Queue the reset behind outstanding parser work and before the next snapshot.
      // A synchronous reset could let an older async write reappear in the new screen.
      term.write("", () => {
        if (!disposed) term.reset();
      });
    },
    focus: focus.focus,
    setVisible: (value) => {
      if (value) term.refresh(0, term.rows - 1);
      else touch.cancel();
    },
    setFocused: (value) => {
      if (!value) touchSelection.clear();
      touch.setEnabled(value);
      focus.setFocused(value);
    },
    paste: (data) => {
      touchSelection.clear();
      touch.cancel();
      term.paste(data);
    },
    hasSelection: () => touchSelection.hasSelection() || term.hasSelection(),
    getSelection: () =>
      touchSelection.isActive() ? touchSelection.getSelection() : term.getSelection(),
    clearSelection: () => {
      touchSelection.clear();
      term.clearSelection();
    },
    isTouchSelectionActive: touchSelection.isActive,
    armTouchSelection: touchSelection.armRangeSelection,
    isTouchSelectionArmed: touchSelection.isRangeSelectionArmed,
    getTouchSelectionAnchor: touchSelection.getActionAnchor,
    fit: () => {
      if (options.layoutGate?.isSuspended()) return;
      const before = { cols: term.cols, rows: term.rows };
      if (
        !applyTerminalGridFit(container, xtermCssCell(term), term, (cols, rows) =>
          term.resize(cols, rows),
        )
      )
        fit.fit();
      if (before.cols !== term.cols) {
        touchSelection.clear();
        touch.cancel();
      } else {
        if (before.rows !== term.rows && !touchSelection.isActive()) touch.cancel();
        touchSelection.refresh();
      }
    },
    cancelScroll: () => {
      touchSelection.clear();
      touch.cancel();
    },
    scrollToBottom: () => {
      touchSelection.clear();
      touch.cancel();
      term.scrollToBottom();
    },
    isAtBottom: () => term.buffer.active.viewportY >= term.buffer.active.baseY,
    getScrollState: () => {
      const buffer = term.buffer.active;
      return {
        offsetLines: Math.max(0, buffer.baseY - buffer.viewportY),
        historyLines: buffer.baseY,
        viewportRows: term.rows,
        alternateScreen: buffer.type === "alternate",
      };
    },
    scrollToOffset: (offsetLines) => {
      touchSelection.clear();
      touch.cancel();
      const historyLines = term.buffer.active.baseY;
      const offset = Math.max(0, Math.min(historyLines, Math.round(offsetLines)));
      term.scrollToLine(historyLines - offset);
    },
    setFontFamily: (value) => {
      touchSelection.clear();
      touch.cancel();
      term.options.fontFamily = value;
    },
    setFontSize: (value) => {
      touchSelection.clear();
      touch.cancel();
      term.options.fontSize = value;
    },
    setReadOnly: (value) => {
      if (term.options.disableStdin !== value) touch.cancel();
      term.options.disableStdin = value;
      focus.setReadOnly(value);
    },
    setSoftKeyboardAllowed: (value) => {
      if (!touchSelection.isActive()) touch.cancel();
      softKeyboard.setAllowed(value);
    },
    applicationCursorKeys: () => term.modes.applicationCursorKeysMode,
    onData: (listener) => term.onData(listener),
    onBinary: (listener) =>
      term.onBinary((data) => listener(Uint8Array.from(data, (byte) => byte.charCodeAt(0)))),
    onResize: (listener) => term.onResize(listener),
    onScroll: (listener) => term.onScroll(listener),
    onSelectionChange: (listener) => {
      const native = term.onSelectionChange(listener);
      const touchSelectionChange = touchSelection.onChange(listener);
      return {
        dispose: () => {
          native.dispose();
          touchSelectionChange.dispose();
        },
      };
    },
    dispose: () => {
      disposed = true;
      touch.dispose();
      touchSelection.dispose();
      userInputIntent.dispose();
      selectionScrollSubscription.dispose();
      clearSelectionOnInput.dispose();
      softKeyboard.dispose();
      focus.dispose();
      term.dispose();
    },
  };
}

function xtermCssCell(term: XtermTerminal): { width: number; height: number } | undefined {
  const cell = (
    term as unknown as {
      _core?: {
        _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
      };
    }
  )._core?._renderService?.dimensions?.css?.cell;
  if (!cell || !(cell.width > 0) || !(cell.height > 0)) return undefined;
  return { width: cell.width, height: cell.height };
}
