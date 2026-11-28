/** Ghostty Web terminal pane backed by a stable CMP v5 persistent session. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ITheme } from "@xterm/xterm";
import type {
  CliLaunchProfile,
  TerminalOpenedReplayMetadata,
  TerminalScrollPositionState,
} from "@cloud-machine/client-contracts";
import {
  isRetryableTerminalError,
  TERMINAL_REPLAY_COMPLETE,
  terminalScrollPositionStateSchema,
} from "@cloud-machine/client-contracts";
import {
  TERMINAL_FONT_FALLBACK,
  TERMINAL_FONT_SIZE,
  onTerminalFontsLoaded,
  terminalFontFamily,
} from "@cloud-machine/workspace-ui/terminal-font";
import { bindTerminalSizeSync } from "@cloud-machine/workspace-ui/terminal-size-sync";
import {
  clientPerformanceNow,
  CLIENT_PERFORMANCE_MEASURES,
  recordClientPerformance,
  type ClientPerformanceDetail,
} from "@cloud-machine/workspace-ui/client-performance";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  CornerDownLeft,
  Copy,
  RefreshCw,
} from "lucide-react";

import { base64ToBytes, bytesToBase64, textToBase64 } from "../lib/base64";
import {
  createMachineConnectionTicket,
  isDefinitiveConnectionTicketRejection,
} from "../lib/connection-ticket";
import { desktopLayoutGate } from "../lib/desktop-layout-state";
import {
  COARSE_POINTER_QUERY,
  PHONE_MEDIA_QUERY,
  getMediaQuerySnapshot,
  useMediaQuery,
  useVirtualKeyboardOpen,
} from "../lib/responsive";
import { gatewayWebSocketUrl, useClientHost } from "../host";
import {
  guardTerminalClipboardRead,
  terminalHistoryPageOffset,
  type TerminalTouchKey,
} from "../lib/terminal-keybindings";
import {
  createTerminalRenderer,
  type TerminalRenderer,
  type TerminalKeyboardHost,
} from "../lib/terminal-renderer";
import { getThemeDefinition, type ThemeId } from "../lib/themes";
import { useThemeStore } from "../stores/theme";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";
import {
  TerminalTouchPhoneRows,
  TouchKeyboardButton,
  TouchKeyButton,
} from "./TerminalTouchToolbar";
import {
  TerminalClipboardFallbackPanel,
  TerminalTouchActionMenu,
  type TerminalClipboardFallback,
} from "./TerminalTouchClipboardUI";
import { TerminalScrollbar } from "./TerminalScrollbar";

type ConnState =
  "idle" | "connecting" | "connected" | "disconnected" | "readonly" | "exited" | "error";

interface ServerMessage extends TerminalOpenedReplayMetadata {
  type:
    | "opened"
    | typeof TERMINAL_REPLAY_COMPLETE
    | "output"
    | "foreground"
    | "exit"
    | "taken_over"
    | "error"
    | "scrollback"
    | "scrollback_error";
  remoteScrollPosition?: boolean;
  scrollback?: unknown;
  inScrollback?: boolean;
  offsetLines?: number;
  historyLines?: number;
  viewportRows?: number;
  alternateScreen?: boolean;
  requestId?: string;
  terminalId?: string;
  data?: string;
  snapshot?: string;
  snapshotTruncated?: boolean;
  resumable?: boolean;
  state?: "running" | "exited";
  exitCode?: number | null;
  message?: string;
  processName?: string | null;
}

interface InitialReplay {
  pendingWrites: number;
  boundaryReceived: boolean;
  complete: () => void;
}

const EMPTY_SCROLL_POSITION: TerminalScrollPositionState = {
  inScrollback: false,
  offsetLines: 0,
  historyLines: 0,
  viewportRows: 1,
  alternateScreen: false,
};

function terminalTheme(themeId: ThemeId): ITheme {
  return { ...getThemeDefinition(themeId).terminal };
}

function exitedNotice(exitCode: number | null | undefined): string {
  return exitCode === null || exitCode === undefined
    ? "终端运行环境已重启，原进程无法恢复"
    : `终端进程已退出（退出码 ${exitCode}）`;
}

export interface TerminalSessionRef {
  workspaceId: string;
  terminalTabId: string;
  paneId: string;
}

export function Terminal({
  machineId,
  workspaceId,
  terminalTabId,
  paneId,
  cwd,
  launchProfile,
  active = true,
  keepConnected = true,
  focused = active,
  focusRequest,
  closing = false,
  connectionActionsHost,
  onForegroundProcessChange,
}: {
  machineId: string;
  workspaceId: string;
  terminalTabId: string;
  paneId: string;
  cwd: string;
  launchProfile?: CliLaunchProfile;
  active?: boolean;
  keepConnected?: boolean;
  focused?: boolean;
  focusRequest?: number;
  closing?: boolean;
  connectionActionsHost?: HTMLElement | null;
  onForegroundProcessChange?: (processName: string | null) => void;
}) {
  const { platform, platformKind } = useClientHost();
  const themeId = useThemeStore((theme) => theme.themeId);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [terminalHost, setTerminalHost] = useState<HTMLDivElement | null>(null);
  const setTerminalContainer = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    setTerminalHost(node);
  }, []);
  const rendererRef = useRef<TerminalRenderer | null>(null);
  const sizeSyncRef = useRef<ReturnType<typeof bindTerminalSizeSync> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const clipboardEpochRef = useRef(0);
  const keyboardHostRef = useRef<TerminalKeyboardHost>({ copy() {}, paste() {} });
  const connectRef = useRef<(restart?: boolean, manual?: boolean) => void>(() => {});
  const disconnectRef = useRef<() => void>(() => {});
  const pauseReconnectRef = useRef<() => void>(() => {});
  const activeRef = useRef(active);
  const keepConnectedRef = useRef(keepConnected);
  const focusedRef = useRef(focused);
  const stateRef = useRef<ConnState>("idle");
  const onForegroundRef = useRef(onForegroundProcessChange);
  const launchProfileRef = useRef(launchProfile);
  useEffect(() => {
    launchProfileRef.current = launchProfile;
  }, [launchProfile]);
  const focusInitialRendererRef = useRef(active && focused);
  // 画面隐藏时 focus() 可能失败；只补偿这次请求，不把 opened 当成新的聚焦意图。
  const pendingContentFocusRef = useRef<{ element: Element | null } | null>(null);
  const observedFocusRequestRef = useRef<number | undefined>(undefined);
  const pendingExplicitFocusRef = useRef<number | undefined>(undefined);
  const [state, setState] = useState<ConnState>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [touchSelectionActive, setTouchSelectionActive] = useState(false);
  const [selectionAnchor, setSelectionAnchor] = useState<{ x: number; y: number } | null>(null);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [clipboardFallback, setClipboardFallback] = useState<TerminalClipboardFallback | null>(
    null,
  );
  const [blankMenuPoint, setBlankMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const [fallbackRenderer, setFallbackRenderer] = useState(false);
  const [contentReady, setContentReady] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [remoteInScrollback, setRemoteInScrollback] = useState(false);
  const [remoteScrollPositionSupported, setRemoteScrollPositionSupported] = useState(false);
  const remoteScrollPositionSupportedRef = useRef(false);
  const [localScrollPosition, setLocalScrollPosition] = useState(EMPTY_SCROLL_POSITION);
  const [remoteScrollPosition, renderRemoteScrollPosition] = useState(EMPTY_SCROLL_POSITION);
  const remoteScrollPositionRef = useRef(EMPTY_SCROLL_POSITION);
  // Key repeat can dispatch several pages before React commits the next render.
  const setRemoteScrollPosition = useCallback(
    (
      update:
        | TerminalScrollPositionState
        | ((current: TerminalScrollPositionState) => TerminalScrollPositionState),
    ) => {
      const value = typeof update === "function" ? update(remoteScrollPositionRef.current) : update;
      remoteScrollPositionRef.current = value;
      renderRemoteScrollPosition(value);
    },
    [],
  );
  const confirmedRemoteScrollPositionRef = useRef(EMPTY_SCROLL_POSITION);
  const awaitingScrollRequestRef = useRef<string | null>(null);
  const scrollRequestSequenceRef = useRef(0);
  const confirmedScrollRequestSequenceRef = useRef(0);
  const [scrollPending, setScrollPending] = useState(false);
  const [scrollError, setScrollError] = useState<string | null>(null);
  const scrollToBottomButtonRef = useRef<HTMLButtonElement | null>(null);
  const keyboardScrollToBottomRef = useRef(false);
  // 触屏设备上软键盘与 DOM 焦点解耦：终端一直持有焦点以显示光标，键盘只在
  // 用户按下工具栏开关后才允许弹出，否则滑动翻历史和 TUI 点击都会被输入法打断。
  const [keyboardAllowed, setKeyboardAllowed] = useState(false);
  const keyboardAllowedRef = useRef(false);
  const keyboardWasOpenRef = useRef(false);
  const [touchShiftArmed, setTouchShiftArmed] = useState(false);
  const touchShiftArmedRef = useRef(false);
  const virtualKeyboardOpen = useVirtualKeyboardOpen();
  const coarsePointer = useMediaQuery(COARSE_POINTER_QUERY);
  const isPhone = useMediaQuery(PHONE_MEDIA_QUERY);
  const [resumable, setResumable] = useState(true);
  const resumableRef = useRef(true);

  const transitionState = useCallback((next: ConnState) => {
    if (stateRef.current !== next) {
      clipboardEpochRef.current++;
      setClipboardFallback(null);
      if (next !== "connected") sizeSyncRef.current?.resetConnection();
    }
    stateRef.current = next;
    setState(next);
  }, []);

  useLayoutEffect(() => {
    const paneFocusChanged = activeRef.current !== active || focusedRef.current !== focused;
    if (paneFocusChanged) clipboardEpochRef.current++;
    activeRef.current = active;
    keepConnectedRef.current = keepConnected;
    focusedRef.current = focused;
    rendererRef.current?.setVisible(active);
    rendererRef.current?.setFocused(active && focused);
    if (paneFocusChanged) sizeSyncRef.current?.syncFocus();
    onForegroundRef.current = onForegroundProcessChange;
  }, [active, focused, keepConnected, onForegroundProcessChange]);

  const hasInputFocus = useCallback(() => {
    const container = containerRef.current;
    const document = container?.ownerDocument;
    return Boolean(
      activeRef.current &&
      focusedRef.current &&
      !desktopLayoutGate.isSuspended() &&
      document &&
      !document.hidden &&
      document.hasFocus() &&
      container.contains(document.activeElement),
    );
  }, []);

  useEffect(() => {
    const document = containerRef.current?.ownerDocument;
    if (!document) return;
    const cancelPendingFocus = (event: FocusEvent) => {
      if (event.target !== pendingContentFocusRef.current?.element)
        pendingContentFocusRef.current = null;
    };
    const cancelPendingExplicitFocus = (event: Event) => {
      if (pendingExplicitFocusRef.current === undefined) return;
      const target = event.target;
      if (target instanceof Element && containerRef.current?.contains(target)) return;
      // A pointer or keyboard action after opening the application is newer
      // user intent; a late renderer must not pull input back into the shell.
      pendingExplicitFocusRef.current = undefined;
    };
    const cancelPendingKeyboardScrollFocus = (event: Event) => {
      if (!keyboardScrollToBottomRef.current) return;
      // Disabling the activated button can temporarily leave focus on the document body.
      // Only a real follow-up interaction or focus move supersedes the restore request.
      if (
        event.type === "focusin" &&
        (event.target === document.body || event.target === document.documentElement)
      )
        return;
      keyboardScrollToBottomRef.current = false;
    };
    document.addEventListener("focusin", cancelPendingFocus, true);
    document.addEventListener("focusin", cancelPendingKeyboardScrollFocus, true);
    document.addEventListener("pointerdown", cancelPendingExplicitFocus, true);
    document.addEventListener("pointerdown", cancelPendingKeyboardScrollFocus, true);
    document.addEventListener("keydown", cancelPendingExplicitFocus, true);
    document.addEventListener("keydown", cancelPendingKeyboardScrollFocus, true);
    return () => {
      document.removeEventListener("focusin", cancelPendingFocus, true);
      document.removeEventListener("focusin", cancelPendingKeyboardScrollFocus, true);
      document.removeEventListener("pointerdown", cancelPendingExplicitFocus, true);
      document.removeEventListener("pointerdown", cancelPendingKeyboardScrollFocus, true);
      document.removeEventListener("keydown", cancelPendingExplicitFocus, true);
      document.removeEventListener("keydown", cancelPendingKeyboardScrollFocus, true);
    };
  }, []);

  const focusSelectedTerminal = useCallback((force = false) => {
    const container = containerRef.current;
    if (!container || !activeRef.current || !focusedRef.current) return;
    const element = container.ownerDocument.activeElement;
    // The pane can mount after the user has already opened another input (for
    // example while the workspace or renderer module was still loading).
    if (
      !force &&
      element?.closest('input, textarea, [contenteditable="true"], [role="textbox"]') &&
      !element.closest("[data-terminal-renderer]")
    )
      return;
    // Selection can come from a toolbar button or the renderer's own input.
    // Neither should be redirected to another input element.
    if (container.closest("[data-terminal-pane-id]")?.contains(element)) return;
    rendererRef.current?.focus();
    pendingContentFocusRef.current = container.contains(container.ownerDocument.activeElement)
      ? null
      : { element: container.ownerDocument.activeElement };
  }, []);

  const focusTerminalLater = useCallback(() => {
    requestAnimationFrame(() => {
      if (activeRef.current && focusedRef.current) rendererRef.current?.focus();
    });
  }, []);

  const applyKeyboardAllowed = useCallback(
    (value: boolean) => {
      keyboardAllowedRef.current = value;
      setKeyboardAllowed(value);
      const renderer = rendererRef.current;
      if (!renderer) return;
      renderer.setSoftKeyboardAllowed(value);
      if (value) {
        // iOS 只在用户手势的同一个任务里聚焦才会升起键盘，不能推迟到下一帧。
        renderer.focus();
        return;
      }
      // 收起键盘时先失焦；隐藏输入框已设为 inputmode=none，随后取回焦点，
      // 恢复光标闪烁与尺寸同步，同时保留外接键盘的 IME 输入能力。
      const container = containerRef.current;
      const view = container?.ownerDocument.defaultView;
      const element = container?.ownerDocument.activeElement;
      if (view && element instanceof view.HTMLElement && container.contains(element))
        element.blur();
      focusTerminalLater();
    },
    [focusTerminalLater],
  );

  const copySelection = useCallback(async () => {
    const renderer = rendererRef.current;
    const container = containerRef.current;
    if (!renderer?.hasSelection() || !container) return;
    const text = renderer.getSelection();
    const guard = guardTerminalClipboardRead(container);
    try {
      await platform.clipboard.writeText(text);
      if (rendererRef.current !== renderer || !guard.valid()) return;
      setClipboardError(null);
      setBlankMenuPoint(null);
      if (renderer.isTouchSelectionActive() && renderer.getSelection() === text)
        renderer.clearSelection();
      // A hardware shortcut already owns focus; do not schedule a later focus steal.
    } catch {
      if (rendererRef.current !== renderer || !guard.valid()) return;
      setClipboardFallback({ mode: "copy", text });
      setClipboardError(null);
    } finally {
      guard.dispose();
    }
  }, [platform]);

  const writeOsc52Clipboard = useCallback(
    async (text: string) => {
      const renderer = rendererRef.current;
      if (!renderer || !hasInputFocus() || stateRef.current !== "connected") return;
      try {
        await platform.clipboard.writeText(text);
        if (rendererRef.current !== renderer || stateRef.current !== "connected") return;
        setClipboardError(null);
        setClipboardFallback(null);
      } catch {
        if (rendererRef.current !== renderer || stateRef.current !== "connected") return;
        setClipboardFallback({ mode: "copy", text });
        setClipboardError(null);
      }
    },
    [hasInputFocus, platform],
  );

  const cancelTouchSelection = useCallback(() => {
    rendererRef.current?.clearSelection();
    setBlankMenuPoint(null);
    setClipboardError(null);
  }, []);

  const pasteClipboard = useCallback(async () => {
    const renderer = rendererRef.current;
    const container = containerRef.current;
    const ws = wsRef.current;
    if (
      !renderer ||
      !container ||
      stateRef.current !== "connected" ||
      ws?.readyState !== WebSocket.OPEN
    )
      return;
    const epoch = clipboardEpochRef.current;
    const guard = guardTerminalClipboardRead(container);
    const valid = () =>
      rendererRef.current === renderer &&
      wsRef.current === ws &&
      clipboardEpochRef.current === epoch &&
      stateRef.current === "connected" &&
      activeRef.current &&
      focusedRef.current &&
      guard.valid();
    try {
      const text = await navigator.clipboard.readText();
      if (!valid()) return;
      if (!text) {
        setClipboardFallback({ mode: "paste" });
        return;
      }
      renderer.paste(text);
      setBlankMenuPoint(null);
      setClipboardError(null);
    } catch {
      if (!valid()) return;
      setClipboardFallback({ mode: "paste" });
      setClipboardError(null);
    } finally {
      guard.dispose();
    }
  }, []);

  const applyTouchShift = useCallback((value: boolean) => {
    touchShiftArmedRef.current = value;
    setTouchShiftArmed(value);
  }, []);

  const sendTouchKey = useCallback(
    (key: TerminalTouchKey) => {
      const shifted = touchShiftArmedRef.current;
      if (shifted) applyTouchShift(false);
      rendererRef.current?.sendKey(key, shifted);
    },
    [applyTouchShift],
  );

  const syncLocalScrollPosition = useCallback((renderer = rendererRef.current, force = false) => {
    if (
      !renderer ||
      (!force &&
        (remoteScrollPositionSupportedRef.current ||
          (resumableRef.current && stateRef.current !== "exited")))
    )
      return;
    const next = renderer.getScrollState();
    const value = {
      ...next,
      inScrollback: next.offsetLines > 0,
    };
    setLocalScrollPosition((current) =>
      current.inScrollback === value.inScrollback &&
      current.offsetLines === value.offsetLines &&
      current.historyLines === value.historyLines &&
      current.viewportRows === value.viewportRows &&
      current.alternateScreen === value.alternateScreen
        ? current
        : value,
    );
  }, []);

  const seekTerminalHistory = useCallback(
    (offsetLines: number) => {
      if (!remoteScrollPositionSupportedRef.current) {
        const renderer = rendererRef.current;
        if (!renderer) return;
        renderer.scrollToOffset(offsetLines);
        syncLocalScrollPosition(renderer, true);
        setShowScrollToBottom(!renderer.isAtBottom());
        return;
      }
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN || stateRef.current !== "connected") return;
      const offset = Math.max(
        0,
        Math.min(remoteScrollPositionRef.current.historyLines, Math.round(offsetLines)),
      );
      setRemoteScrollPosition((current) => ({
        ...current,
        offsetLines: offset,
        inScrollback: offset > 0,
      }));
      setRemoteInScrollback(offset > 0);
      setScrollError(null);
      setScrollPending(false);
      const requestId = `scroll-${++scrollRequestSequenceRef.current}`;
      awaitingScrollRequestRef.current = requestId;
      ws.send(JSON.stringify({ type: "scroll_to", offsetLines: offset, requestId }));
    },
    [setRemoteScrollPosition, syncLocalScrollPosition],
  );

  useLayoutEffect(() => {
    const historyPosition = () => {
      if (stateRef.current === "exited" || !resumableRef.current)
        return rendererRef.current?.getScrollState() ?? null;
      if (stateRef.current !== "connected" || !remoteScrollPositionSupportedRef.current)
        return null;
      return remoteScrollPositionRef.current;
    };
    keyboardHostRef.current = {
      copy: () => void copySelection(),
      paste: () => void pasteClipboard(),
      history: {
        alternateScreen: () => historyPosition()?.alternateScreen ?? null,
        page: (pages) => {
          const position = historyPosition();
          if (!position || position.alternateScreen) return;
          const offset = terminalHistoryPageOffset(position, pages);
          if (offset !== position.offsetLines) seekTerminalHistory(offset);
        },
      },
    };
  }, [copySelection, pasteClipboard, seekTerminalHistory]);

  const scrollToBottom = useCallback((): "local" | "remote" | null => {
    const renderer = rendererRef.current;
    if (!renderer) return null;
    renderer.cancelScroll();
    setScrollError(null);
    if (remoteInScrollback) {
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN || stateRef.current !== "connected" || scrollPending)
        return null;
      const requestId = `scroll-${++scrollRequestSequenceRef.current}`;
      awaitingScrollRequestRef.current = requestId;
      setScrollPending(true);
      setRemoteScrollPosition((current) => ({ ...current, offsetLines: 0, inScrollback: false }));
      ws.send(JSON.stringify({ type: "scroll_to", offsetLines: 0, requestId }));
      return "remote";
    }
    renderer.scrollToBottom();
    syncLocalScrollPosition(renderer);
    setShowScrollToBottom(false);
    return "local";
  }, [remoteInScrollback, scrollPending, setRemoteScrollPosition, syncLocalScrollPosition]);

  const activateScrollToBottom = useCallback(
    (keyboardActivated: boolean) => {
      if (!keyboardActivated) {
        scrollToBottom();
        return;
      }
      keyboardScrollToBottomRef.current = true;
      const action = scrollToBottom();
      if (!action) {
        keyboardScrollToBottomRef.current = false;
        return;
      }
      if (action === "local") {
        requestAnimationFrame(() => {
          if (!keyboardScrollToBottomRef.current) return;
          keyboardScrollToBottomRef.current = false;
          if (activeRef.current && focusedRef.current) rendererRef.current?.focus();
        });
      }
    },
    [scrollToBottom],
  );

  useEffect(() => {
    if (!keyboardScrollToBottomRef.current || scrollPending) return;
    const frame = requestAnimationFrame(() => {
      // A pointer, key, or focus move after activation is newer user intent.
      if (!keyboardScrollToBottomRef.current) return;
      keyboardScrollToBottomRef.current = false;
      const retryButton = scrollError ? scrollToBottomButtonRef.current : null;
      if (retryButton && scrollToBottomButtonRef.current === retryButton && !retryButton.disabled) {
        retryButton.focus();
        return;
      }
      if (activeRef.current && focusedRef.current) rendererRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollError, scrollPending]);

  useEffect(() => {
    if (!scrollPending) return;
    const timer = setTimeout(() => {
      setScrollPending(false);
      setScrollError("回到底部超时，请重试");
    }, 10_000);
    return () => clearTimeout(timer);
  }, [scrollPending]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const initialFocus = container.ownerDocument.activeElement;
    const phoneMedia = container.ownerDocument.defaultView?.matchMedia?.(PHONE_MEDIA_QUERY);
    const touchMedia = container.ownerDocument.defaultView?.matchMedia?.(COARSE_POINTER_QUERY);
    let fontSize = getMediaQuerySnapshot(PHONE_MEDIA_QUERY)
      ? TERMINAL_FONT_SIZE.phone
      : TERMINAL_FONT_SIZE.default;
    const initialization = new AbortController();
    const rendererStartedAt = clientPerformanceNow();
    let disposed = false;
    let generation = 0;
    let connectionTimer: ReturnType<typeof setTimeout> | null = null;
    const clearConnectionDeadline = () => {
      if (connectionTimer) clearTimeout(connectionTimer);
      connectionTimer = null;
    };
    let connecting = false;
    let authorizationRevoked = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let resizeFrame = 0;
    let initialFocusFrame = 0;
    const subscriptions: Array<{ dispose(): void }> = [];
    type PreparedConnection = {
      ws: WebSocket;
      startedAt: number;
      detail: ClientPerformanceDetail;
    };
    type ConnectionPreparation = {
      promise: Promise<PreparedConnection>;
      cancel: () => void;
    };
    let preparedConnection: ConnectionPreparation | null = null;
    let activePreparation: ConnectionPreparation | null = null;

    const createConnectionPreparation = (
      startedAt: number,
      detail: ClientPerformanceDetail,
    ): ConnectionPreparation => {
      let cancelled = false;
      let pendingSocket: WebSocket | null = null;
      let stage: "ticket" | "socket" = "ticket";
      const cancel = () => {
        cancelled = true;
        if (
          pendingSocket &&
          pendingSocket.readyState !== WebSocket.CLOSED &&
          pendingSocket.readyState !== WebSocket.CLOSING
        )
          pendingSocket.close();
      };
      const promise = (async (): Promise<PreparedConnection> => {
        try {
          const ticket = await createMachineConnectionTicket(machineId, "terminal");
          if (cancelled || disposed || !keepConnectedRef.current)
            throw new Error("terminal connection preparation cancelled");
          if (!ticket) throw new Error("terminal connection ticket missing");
          recordClientPerformance(
            CLIENT_PERFORMANCE_MEASURES.terminalTicketReady,
            startedAt,
            detail,
          );
          stage = "socket";
          const ws = new WebSocket(
            gatewayWebSocketUrl(
              `/machines/${encodeURIComponent(machineId)}/terminal?ticket=${encodeURIComponent(ticket)}`,
            ),
          );
          pendingSocket = ws;
          await new Promise<void>((resolve, reject) => {
            const clearPreparationHandlers = () => {
              ws.onopen = null;
              ws.onerror = null;
              ws.onclose = null;
            };
            ws.onopen = () => {
              clearPreparationHandlers();
              resolve();
            };
            ws.onerror = () => {
              clearPreparationHandlers();
              reject(new Error("terminal WebSocket handshake failed"));
            };
            ws.onclose = () => {
              clearPreparationHandlers();
              reject(new Error("terminal WebSocket closed during handshake"));
            };
          });
          if (
            cancelled ||
            disposed ||
            !keepConnectedRef.current ||
            ws.readyState !== WebSocket.OPEN
          ) {
            ws.close();
            throw new Error("terminal WebSocket preparation cancelled");
          }
          recordClientPerformance(
            CLIENT_PERFORMANCE_MEASURES.terminalSocketOpen,
            startedAt,
            detail,
          );
          return { ws, startedAt, detail };
        } catch (error) {
          const shouldRecordFailure = !cancelled && !disposed && keepConnectedRef.current;
          cancel();
          if (shouldRecordFailure)
            recordClientPerformance(
              stage === "ticket"
                ? CLIENT_PERFORMANCE_MEASURES.terminalTicketReady
                : CLIENT_PERFORMANCE_MEASURES.terminalSocketOpen,
              startedAt,
              { ...detail, outcome: "error" },
            );
          throw error;
        }
      })();
      return { promise, cancel };
    };

    const cancelPreparations = () => {
      const prepared = preparedConnection;
      preparedConnection = null;
      prepared?.cancel();
      const active = activePreparation;
      activePreparation = null;
      if (active !== prepared) active?.cancel();
    };

    if (activeRef.current && keepConnectedRef.current) {
      preparedConnection = createConnectionPreparation(rendererStartedAt, {
        client: platformKind,
        temperature: "cold",
        outcome: "success",
      });
      void preparedConnection.promise.catch(() => undefined);
    }

    const focusInitialTerminal = () => {
      cancelAnimationFrame(initialFocusFrame);
      const settleFocus = () => {
        if (disposed || !activeRef.current || !focusedRef.current) return;
        // Base UI restores focus to a menu trigger after its closing animation.
        // Wait for the portal to unmount so that restoration cannot overwrite
        // the new terminal's focus.
        if (
          container.ownerDocument.querySelector(
            '[data-slot="dropdown-menu-content"], [data-slot="context-menu-content"]',
          )
        ) {
          initialFocusFrame = requestAnimationFrame(settleFocus);
          return;
        }
        focusSelectedTerminal();
      };
      initialFocusFrame = requestAnimationFrame(settleFocus);
    };

    const clearReconnect = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };
    pauseReconnectRef.current = clearReconnect;

    const disconnect = () => {
      generation += 1;
      connecting = false;
      cancelPreparations();
      clearConnectionDeadline();
      clearReconnect();
      awaitingScrollRequestRef.current = null;
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING)
        ws.close();
      rendererRef.current?.setReadOnly(true);
      if (
        !disposed &&
        !authorizationRevoked &&
        stateRef.current !== "exited" &&
        stateRef.current !== "readonly" &&
        stateRef.current !== "error"
      ) {
        transitionState("disconnected");
        setNotice(null);
      }
    };
    disconnectRef.current = disconnect;

    void createTerminalRenderer(
      container,
      {
        fontFamily: TERMINAL_FONT_FALLBACK,
        visible: activeRef.current,
        isPhoneApplication: () =>
          launchProfileRef.current?.mode === "run" &&
          phoneMedia?.matches === true &&
          touchMedia?.matches === true,
        isLiveCursorApplication: () =>
          launchProfileRef.current?.appId === "cursor" &&
          launchProfileRef.current.mode === "run" &&
          stateRef.current === "connected" &&
          !remoteScrollPositionRef.current.inScrollback &&
          awaitingScrollRequestRef.current === null,
        layoutGate: desktopLayoutGate,
        fontSize,
        // ghostty-web 0.4.0 在创建时把调色板固化进 WASM 单元格，setTheme 无法给既有
        // 文本换色；主题切换通过重建渲染器完成（themeId 在本 effect 依赖中），
        // RMUX 会话与历史由重连回放恢复。
        theme: terminalTheme(themeId),
        onBlankLongPress: (point) => {
          if (getMediaQuerySnapshot(PHONE_MEDIA_QUERY)) setBlankMenuPoint(point);
        },
        onClipboardWrite: writeOsc52Clipboard,
        keyboardHost: {
          copy: () => keyboardHostRef.current.copy(),
          paste: () => keyboardHostRef.current.paste(),
          history: {
            alternateScreen: () => keyboardHostRef.current.history?.alternateScreen() ?? null,
            page: (pages) => keyboardHostRef.current.history?.page(pages),
          },
        },
      },
      initialization.signal,
    )
      .then((renderer) => {
        if (disposed) {
          renderer.dispose();
          return;
        }
        rendererRef.current = renderer;
        recordClientPerformance(
          CLIENT_PERFORMANCE_MEASURES.terminalRendererReady,
          rendererStartedAt,
          { client: platformKind, temperature: "cold", outcome: "success" },
        );
        // A new renderer has no cached picture (identity/theme changes included).
        setContentReady(false);
        transitionState("idle");
        renderer.setReadOnly(true);
        renderer.setVisible(activeRef.current);
        renderer.setFocused(activeRef.current && focusedRef.current);
        // 主题切换会重建渲染器：新的宿主必须继承当前的软键盘开关状态。
        renderer.setSoftKeyboardAllowed(keyboardAllowedRef.current);
        setFallbackRenderer(renderer.backend === "xterm");
        setHasSelection(false);
        setTouchSelectionActive(false);
        setSelectionAnchor(null);
        setBlankMenuPoint(null);
        setClipboardFallback(null);
        remoteScrollPositionSupportedRef.current = false;
        setRemoteScrollPositionSupported(false);
        confirmedRemoteScrollPositionRef.current = EMPTY_SCROLL_POSITION;
        setRemoteScrollPosition(EMPTY_SCROLL_POSITION);
        awaitingScrollRequestRef.current = null;
        syncLocalScrollPosition(renderer);
        // The first renderer for a newly mounted active pane must complete the
        // focus request that ran before async initialization finished. Renderer
        // rebuilds (for example after a theme change) retain the conservative
        // focus guard so they do not steal focus from another control.
        if (focusInitialRendererRef.current) {
          focusInitialRendererRef.current = false;
          focusInitialTerminal();
        } else if (container.ownerDocument.activeElement === initialFocus) {
          focusSelectedTerminal();
        }

        const sizeSync = bindTerminalSizeSync(container, renderer, {
          isActive: () => activeRef.current,
          isSelected: () => focusedRef.current,
          connectedSocket: () => {
            const ws = wsRef.current;
            return rendererRef.current === renderer &&
              stateRef.current === "connected" &&
              ws?.readyState === WebSocket.OPEN
              ? ws
              : null;
          },
          onFit: () => syncLocalScrollPosition(renderer),
          layoutGate: desktopLayoutGate,
        });
        sizeSyncRef.current = sizeSync;
        subscriptions.push(sizeSync);
        const { fit } = sizeSync;

        const revokeAuthorization = () => {
          authorizationRevoked = true;
          disconnect();
          remoteScrollPositionSupportedRef.current = false;
          setRemoteScrollPositionSupported(false);
          confirmedRemoteScrollPositionRef.current = EMPTY_SCROLL_POSITION;
          setRemoteScrollPosition(EMPTY_SCROLL_POSITION);
          renderer.reset();
          syncLocalScrollPosition(renderer, true);
          setContentReady(false);
          setShowScrollToBottom(false);
          setRemoteInScrollback(false);
          setScrollPending(false);
          setScrollError(null);
          transitionState("error");
          setNotice("访问权限已失效，请重新登录或打开项目");
        };

        const scheduleReconnect = () => {
          if (disposed || !activeRef.current || !keepConnectedRef.current || reconnectTimer) return;
          const delay = Math.min(10_000, 1_000 * 2 ** reconnectAttempt++);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, delay);
        };

        const connect = (restart = false, manual = false) => {
          if (disposed || !activeRef.current || !keepConnectedRef.current) return;
          if (connecting) return;
          if (
            !manual &&
            (authorizationRevoked ||
              stateRef.current === "exited" ||
              stateRef.current === "readonly" ||
              stateRef.current === "error" ||
              wsRef.current?.readyState === WebSocket.OPEN ||
              wsRef.current?.readyState === WebSocket.CONNECTING)
          )
            return;
          const attemptTemperature = stateRef.current === "disconnected" ? "warm" : "cold";
          const preparation = preparedConnection;
          preparedConnection = null;
          disconnect();
          authorizationRevoked = false;
          connecting = true;
          const currentGeneration = ++generation;
          // 仅延续终端自身的聚焦意图；外部控件已有焦点时不申请恢复。
          if (container.contains(container.ownerDocument.activeElement))
            pendingContentFocusRef.current = { element: container.ownerDocument.body };
          setScrollPending(false);
          setScrollError(null);
          renderer.setReadOnly(true);
          // Keep this renderer's old picture read-only until a replacement snapshot arrives.
          transitionState("connecting");
          setNotice(null);
          connectionTimer = setTimeout(() => {
            if (disposed || currentGeneration !== generation) return;
            disconnect();
            setNotice("终端连接超时，等待恢复，暂不可输入");
            scheduleReconnect();
          }, 40_000);
          const attemptStartedAt = clientPerformanceNow();
          const detail: ClientPerformanceDetail = {
            client: platformKind,
            temperature: attemptTemperature,
            outcome: "success",
          };
          const connection = preparation ?? createConnectionPreparation(attemptStartedAt, detail);
          activePreparation = connection;
          void connection.promise
            .then(({ ws, startedAt, detail: attemptDetail }) => {
              if (activePreparation === connection) activePreparation = null;
              if (disposed || currentGeneration !== generation || !keepConnectedRef.current) {
                ws.close();
                return;
              }
              wsRef.current = ws;
              let receivedOpened = false;
              let attachmentActive = false;
              let initialReplay: InitialReplay | null = null;
              const finishInitialReplay = (replay: InitialReplay) => {
                if (
                  initialReplay !== replay ||
                  !replay.boundaryReceived ||
                  replay.pendingWrites !== 0
                )
                  return;
                initialReplay = null;
                replay.complete();
              };
              const writeInitialReplay = (replay: InitialReplay, data: string | Uint8Array) => {
                replay.pendingWrites += 1;
                renderer.write(data, () => {
                  if (initialReplay !== replay || disposed || currentGeneration !== generation)
                    return;
                  replay.pendingWrites -= 1;
                  finishInitialReplay(replay);
                });
              };
              ws.onmessage = (event: MessageEvent<string>) => {
                if (currentGeneration !== generation) return;
                let message: ServerMessage;
                try {
                  message = JSON.parse(event.data) as ServerMessage;
                } catch {
                  return;
                }
                switch (message.type) {
                  case "opened": {
                    if (receivedOpened) break;
                    receivedOpened = true;
                    recordClientPerformance(
                      CLIENT_PERFORMANCE_MEASURES.terminalOpened,
                      startedAt,
                      attemptDetail,
                    );
                    attachmentActive = message.state !== "exited";
                    const supportsRemotePosition = message.remoteScrollPosition === true;
                    remoteScrollPositionSupportedRef.current = supportsRemotePosition;
                    setRemoteScrollPositionSupported(supportsRemotePosition);
                    const initialScrollback = terminalScrollPositionStateSchema.safeParse(
                      message.scrollback,
                    );
                    if (supportsRemotePosition && initialScrollback.success) {
                      confirmedRemoteScrollPositionRef.current = initialScrollback.data;
                      setRemoteScrollPosition(initialScrollback.data);
                      setRemoteInScrollback(initialScrollback.data.inScrollback);
                    } else {
                      confirmedRemoteScrollPositionRef.current = EMPTY_SCROLL_POSITION;
                      setRemoteScrollPosition(EMPTY_SCROLL_POSITION);
                      setRemoteInScrollback(false);
                    }
                    awaitingScrollRequestRef.current = null;
                    const boundedReplay = message.replayCompleteFollows === true;
                    if (boundedReplay) {
                      // Hide synchronously before reset/write: React state alone would leave the
                      // Ghostty canvas visible until the event batch commits.
                      container.style.visibility = "hidden";
                      setContentReady(false);
                    }
                    renderer.reset();
                    setShowScrollToBottom(false);
                    resumableRef.current = message.resumable !== false;
                    setResumable(resumableRef.current);
                    const completeOpened = () => {
                      // xterm parses asynchronously; late callbacks must not revive a closed
                      // connection, an exited Shell, or an attachment taken over meanwhile.
                      if (disposed || currentGeneration !== generation) return;
                      clearConnectionDeadline();
                      renderer.scrollToBottom();
                      syncLocalScrollPosition(renderer, message.state === "exited");
                      connecting = false;
                      container.style.visibility = "visible";
                      setContentReady(true);
                      recordClientPerformance(
                        CLIENT_PERFORMANCE_MEASURES.terminalInteractive,
                        startedAt,
                        message.state === "exited"
                          ? { ...attemptDetail, outcome: "error" }
                          : attemptDetail,
                      );
                      if (stateRef.current !== "connecting") return;
                      if (message.state === "exited") {
                        transitionState("exited");
                        setNotice(exitedNotice(message.exitCode));
                      } else {
                        reconnectAttempt = 0;
                        renderer.setReadOnly(false);
                        transitionState("connected");
                        sizeSync.opened();
                      }
                    };
                    const snapshot = message.snapshot ? base64ToBytes(message.snapshot) : "";
                    if (boundedReplay) {
                      const replay: InitialReplay = {
                        pendingWrites: 0,
                        boundaryReceived: false,
                        complete: completeOpened,
                      };
                      initialReplay = replay;
                      writeInitialReplay(replay, snapshot);
                    } else {
                      renderer.write(snapshot, completeOpened);
                    }
                    break;
                  }
                  case TERMINAL_REPLAY_COMPLETE: {
                    const replay = initialReplay;
                    if (!replay) break;
                    replay.boundaryReceived = true;
                    finishInitialReplay(replay);
                    break;
                  }
                  case "output":
                    if (receivedOpened && attachmentActive && message.data) {
                      const data = base64ToBytes(message.data);
                      const replay = initialReplay;
                      if (replay && !replay.boundaryReceived) writeInitialReplay(replay, data);
                      else renderer.write(data, () => syncLocalScrollPosition(renderer));
                    }
                    break;
                  case "foreground":
                    if (attachmentActive) onForegroundRef.current?.(message.processName ?? null);
                    break;
                  case "scrollback": {
                    if (!attachmentActive) break;
                    const positioned = terminalScrollPositionStateSchema.safeParse(message);
                    if (!positioned.success) break;
                    if (message.requestId) {
                      const sequence = /^scroll-(\d+)$/.exec(message.requestId)?.[1];
                      if (
                        !sequence ||
                        Number(sequence) < confirmedScrollRequestSequenceRef.current ||
                        Number(sequence) > scrollRequestSequenceRef.current
                      )
                        break;
                      confirmedScrollRequestSequenceRef.current = Number(sequence);
                    }
                    const awaiting = awaitingScrollRequestRef.current;
                    const acceptsPosition =
                      !awaiting ||
                      (message.requestId !== undefined && message.requestId === awaiting);
                    if (acceptsPosition) {
                      if (message.requestId === awaiting) awaitingScrollRequestRef.current = null;
                      confirmedRemoteScrollPositionRef.current = positioned.data;
                      setRemoteScrollPosition(positioned.data);
                      setRemoteInScrollback(positioned.data.inScrollback);
                    } else {
                      // Polling can race an in-flight drag. Refresh bounds and mode without
                      // pulling the optimistic thumb back to an older acknowledged position.
                      confirmedRemoteScrollPositionRef.current = positioned.data;
                      setRemoteScrollPosition((current) => ({
                        ...positioned.data,
                        offsetLines: Math.min(current.offsetLines, positioned.data.historyLines),
                        inScrollback:
                          Math.min(current.offsetLines, positioned.data.historyLines) > 0,
                      }));
                    }
                    if (!positioned.data.inScrollback && acceptsPosition) {
                      setScrollPending(false);
                      setScrollError(null);
                    }
                    break;
                  }
                  case "scrollback_error":
                    if (!attachmentActive) break;
                    if (
                      message.requestId &&
                      message.requestId !== `scroll-${scrollRequestSequenceRef.current}`
                    )
                      break;
                    awaitingScrollRequestRef.current = null;
                    setRemoteScrollPosition(confirmedRemoteScrollPositionRef.current);
                    setRemoteInScrollback(confirmedRemoteScrollPositionRef.current.inScrollback);
                    setScrollPending(false);
                    setScrollError(message.message ?? "定位终端历史失败，请重试");
                    break;
                  case "exit":
                    if (!attachmentActive) break;
                    clearConnectionDeadline();
                    attachmentActive = false;
                    connecting = false;
                    awaitingScrollRequestRef.current = null;
                    remoteScrollPositionSupportedRef.current = false;
                    setRemoteScrollPositionSupported(false);
                    setRemoteInScrollback(false);
                    setScrollPending(false);
                    renderer.setReadOnly(true);
                    syncLocalScrollPosition(renderer, true);
                    onForegroundRef.current?.(null);
                    transitionState("exited");
                    setNotice(exitedNotice(message.exitCode));
                    break;
                  case "taken_over":
                    clearConnectionDeadline();
                    attachmentActive = false;
                    connecting = false;
                    awaitingScrollRequestRef.current = null;
                    remoteScrollPositionSupportedRef.current = false;
                    setRemoteScrollPositionSupported(false);
                    setRemoteInScrollback(false);
                    setScrollPending(false);
                    renderer.setReadOnly(true);
                    onForegroundRef.current?.(null);
                    transitionState("readonly");
                    setNotice("此终端已在另一设备或窗口接管，当前画面已暂停");
                    break;
                  case "error":
                    if (
                      authorizationRevoked ||
                      stateRef.current === "exited" ||
                      stateRef.current === "readonly" ||
                      stateRef.current === "error"
                    )
                      break;
                    if (isRetryableTerminalError(message)) {
                      disconnect();
                      setNotice("终端连接中断，等待恢复，暂不可输入");
                      scheduleReconnect();
                      break;
                    }
                    attachmentActive = false;
                    connecting = false;
                    renderer.setReadOnly(true);
                    transitionState("error");
                    clearConnectionDeadline();
                    setNotice("终端通道发生错误，请重试");
                    break;
                }
              };
              ws.onclose = (event) => {
                if (wsRef.current === ws) wsRef.current = null;
                if (disposed || currentGeneration !== generation) return;
                clearConnectionDeadline();
                generation += 1;
                connecting = false;
                awaitingScrollRequestRef.current = null;
                setScrollPending(false);
                if (event.code === 1008) {
                  revokeAuthorization();
                  return;
                }
                const currentState = stateRef.current;
                renderer.setReadOnly(true);
                if (
                  currentState !== "exited" &&
                  currentState !== "readonly" &&
                  currentState !== "error"
                ) {
                  transitionState("disconnected");
                }
                if (
                  reconnectTimer ||
                  currentState === "exited" ||
                  currentState === "readonly" ||
                  currentState === "error"
                ) {
                  return;
                }
                scheduleReconnect();
              };
              ws.onerror = () => {
                if (currentGeneration !== generation) return;
                renderer.setReadOnly(true);
                if (
                  stateRef.current === "exited" ||
                  stateRef.current === "readonly" ||
                  stateRef.current === "error"
                )
                  return;
                transitionState(connecting ? "connecting" : "disconnected");
                setNotice("终端连接中断，正在自动恢复…");
              };
              fit();
              ws.send(
                JSON.stringify({
                  type: restart ? "restart" : "attach",
                  workspaceId,
                  terminalTabId,
                  paneId,
                  cols: renderer.cols,
                  rows: renderer.rows,
                  cwd,
                  launchProfile: launchProfileRef.current,
                }),
              );
            })
            .catch((error: unknown) => {
              if (activePreparation === connection) activePreparation = null;
              if (disposed || currentGeneration !== generation) return;
              if (isDefinitiveConnectionTicketRejection(error)) {
                revokeAuthorization();
                return;
              }
              disconnect();
              setNotice("终端连接中断，正在自动恢复…");
              scheduleReconnect();
            });
        };
        connectRef.current = connect;

        const syncSelection = () => {
          const touchActive = renderer.isTouchSelectionActive();
          setHasSelection(renderer.hasSelection());
          setTouchSelectionActive(touchActive);
          setSelectionAnchor(touchActive ? renderer.getTouchSelectionAnchor() : null);
          if (touchActive) setBlankMenuPoint(null);
          if (touchActive && keyboardAllowedRef.current) applyKeyboardAllowed(false);
        };

        subscriptions.push(
          renderer.onData((data) => {
            const ws = wsRef.current;
            if (ws?.readyState === WebSocket.OPEN && stateRef.current === "connected") {
              ws.send(JSON.stringify({ type: "input", data: textToBase64(data) }));
            }
          }),
          renderer.onBinary((data) => {
            const ws = wsRef.current;
            if (ws?.readyState === WebSocket.OPEN && stateRef.current === "connected") {
              ws.send(JSON.stringify({ type: "input", data: bytesToBase64(data) }));
            }
          }),
          renderer.onResize(({ cols, rows }) => {
            syncLocalScrollPosition(renderer);
            const ws = wsRef.current;
            if (
              activeRef.current &&
              !desktopLayoutGate.isSuspended() &&
              ws?.readyState === WebSocket.OPEN &&
              stateRef.current === "connected"
            ) {
              ws.send(JSON.stringify({ type: "resize", cols, rows }));
            }
          }),
          renderer.onScroll(() => {
            syncLocalScrollPosition(renderer);
            if (!remoteScrollPositionSupportedRef.current)
              setShowScrollToBottom(!renderer.isAtBottom());
          }),
          renderer.onSelectionChange(syncSelection),
        );

        const resizeObserver = new ResizeObserver(() => {
          cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(fit);
        });
        resizeObserver.observe(container);
        // 手机的外层可见宽度可能变化而终端宿主宽度不变，仍需更新列数。
        for (let parent = container.parentElement; parent; parent = parent.parentElement)
          resizeObserver.observe(parent);
        const viewport = container.ownerDocument.defaultView?.visualViewport;
        const scheduleFit = () => {
          cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(fit);
        };
        viewport?.addEventListener("resize", scheduleFit);
        let stopFontListener = () => {};
        const syncFontSize = () => {
          if (desktopLayoutGate.isSuspended()) return;
          const nextSize = getMediaQuerySnapshot(PHONE_MEDIA_QUERY)
            ? TERMINAL_FONT_SIZE.phone
            : TERMINAL_FONT_SIZE.default;
          if (nextSize !== fontSize) {
            fontSize = nextSize;
            renderer.setFontSize(fontSize);
          }
          stopFontListener();
          stopFontListener = onTerminalFontsLoaded(container, fontSize, () => {
            renderer.setFontFamily(terminalFontFamily(container));
            fit();
          });
          fit();
        };
        // 原地更新字号，不让断点切换重建渲染器或重连；也覆盖异步初始化期间的变化。
        phoneMedia?.addEventListener("change", syncFontSize);
        const stopLayout = desktopLayoutGate.subscribe(() => {
          cancelAnimationFrame(resizeFrame);
          if (!desktopLayoutGate.isSuspended()) resizeFrame = requestAnimationFrame(syncFontSize);
        });
        syncFontSize();
        if (activeRef.current) connect();

        subscriptions.push({
          dispose: () => {
            stopLayout();
            resizeObserver.disconnect();
            viewport?.removeEventListener("resize", scheduleFit);
            phoneMedia?.removeEventListener("change", syncFontSize);
            stopFontListener();
            cancelAnimationFrame(resizeFrame);
          },
        });
      })
      .catch(() => {
        if (disposed) return;
        cancelPreparations();
        recordClientPerformance(
          CLIENT_PERFORMANCE_MEASURES.terminalRendererReady,
          rendererStartedAt,
          { client: platformKind, temperature: "cold", outcome: "error" },
        );
        transitionState("error");
        setNotice("终端渲染器加载失败，请刷新页面后重试");
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(initialFocusFrame);
      initialization.abort();
      disconnect();
      subscriptions.forEach((subscription) => subscription.dispose());
      sizeSyncRef.current = null;
      rendererRef.current?.dispose();
      rendererRef.current = null;
      connectRef.current = () => {};
      disconnectRef.current = () => {};
      pauseReconnectRef.current = () => {};
      onForegroundRef.current?.(null);
    };
  }, [
    cwd,
    machineId,
    paneId,
    platformKind,
    terminalTabId,
    themeId,
    transitionState,
    workspaceId,
    focusSelectedTerminal,
    hasInputFocus,
    applyKeyboardAllowed,
    syncLocalScrollPosition,
    writeOsc52Clipboard,
    setRemoteScrollPosition,
  ]);

  useEffect(() => {
    if (!active) pauseReconnectRef.current();
    if (!keepConnected) {
      disconnectRef.current();
      return;
    }
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (!activeRef.current) return;
      sizeSyncRef.current?.fit();
      if (!wsRef.current) connectRef.current(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, keepConnected]);

  useEffect(() => {
    if (!active || !focused) return;
    const initialFocus = document.activeElement;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === initialFocus) focusSelectedTerminal();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, focused, focusSelectedTerminal]);

  useEffect(() => {
    if (focusRequest === undefined) {
      pendingExplicitFocusRef.current = undefined;
      return;
    }
    if (observedFocusRequestRef.current !== focusRequest) {
      observedFocusRequestRef.current = focusRequest;
      pendingExplicitFocusRef.current = focusRequest;
    }
    if (pendingExplicitFocusRef.current !== focusRequest || !active || !focused) return;
    let settleFrame = 0;
    const visibilityFrame = requestAnimationFrame(() => {
      // The workspace terminal can become visible in the same render. Let its
      // normal focus restoration finish before the explicit application request.
      settleFrame = requestAnimationFrame(() => {
        focusSelectedTerminal(true);
        const container = containerRef.current;
        if (container?.contains(container.ownerDocument.activeElement))
          pendingExplicitFocusRef.current = undefined;
      });
    });
    return () => {
      cancelAnimationFrame(visibilityFrame);
      cancelAnimationFrame(settleFrame);
    };
  }, [active, contentReady, focusRequest, focused, focusSelectedTerminal]);

  useEffect(() => {
    if (active && focused && state === "connected") return;
    if (touchShiftArmedRef.current) applyTouchShift(false);
  }, [active, applyTouchShift, focused, state]);

  useEffect(() => {
    if (!contentReady || !active || !focused) return;
    const pending = pendingContentFocusRef.current;
    const frame = requestAnimationFrame(() => {
      if (
        pending &&
        pendingContentFocusRef.current === pending &&
        containerRef.current?.ownerDocument.activeElement === pending.element
      )
        focusSelectedTerminal();
      pendingContentFocusRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, focused, contentReady, focusSelectedTerminal]);

  // 切走的 Pane 不该在回来时又带着键盘。
  useEffect(() => {
    if (active && focused) return;
    if (keyboardAllowedRef.current) applyKeyboardAllowed(false);
  }, [active, applyKeyboardAllowed, focused]);

  // 系统返回键或收起手势关掉键盘后同步开关，否则下一次触摸又会被输入法接管。
  useEffect(() => {
    if (!keyboardAllowed) {
      keyboardWasOpenRef.current = false;
      return;
    }
    if (virtualKeyboardOpen) {
      keyboardWasOpenRef.current = true;
      return;
    }
    if (!keyboardWasOpenRef.current) return;
    // 工具栏按键会短暂夺走焦点，键盘可能马上重新升起：留一个窗口，确实收起了才复位。
    const timer = setTimeout(() => {
      keyboardWasOpenRef.current = false;
      applyKeyboardAllowed(false);
    }, 500);
    return () => clearTimeout(timer);
  }, [applyKeyboardAllowed, keyboardAllowed, virtualKeyboardOpen]);

  const scrollbarPosition = remoteScrollPositionSupported
    ? remoteScrollPosition
    : localScrollPosition;
  const scrollbarAvailable = remoteScrollPositionSupported || !resumable || state === "exited";
  const connectionAction =
    state === "exited" ? "重新启动" : state === "readonly" ? "接管" : "重新连接";

  return (
    <div className="cm-terminal-surface flex h-full min-h-0 min-w-0 flex-col">
      {connectionActionsHost &&
        createPortal(
          <button
            type="button"
            className="cm-icon-button"
            aria-label={connectionAction}
            title={state === "connected" ? "重新连接，保留应用进程和历史" : connectionAction}
            disabled={
              closing || !active || !keepConnected || state === "idle" || state === "connecting"
            }
            onClick={() => connectRef.current(stateRef.current === "exited", true)}
          >
            <RefreshCw size={12} className={state === "connecting" ? "animate-spin" : undefined} />
          </button>,
          connectionActionsHost,
        )}
      {!closing &&
        ((state === "connecting" && contentReady) ||
          state === "error" ||
          state === "disconnected" ||
          state === "readonly" ||
          state === "exited") && (
          <div className="flex min-h-8 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-400">
            <span className={state === "error" ? "text-red-400" : undefined}>
              {state === "connecting"
                ? "连接恢复中，暂不可输入"
                : (notice ?? "终端已断开，暂不可输入")}
            </span>
            {!connectionActionsHost && (
              <button
                type="button"
                disabled={state === "connecting"}
                onClick={() => connectRef.current(state === "exited", true)}
                className="cm-terminal-connection-action cm-button ml-auto"
              >
                {state === "exited" ? "重新启动" : state === "readonly" ? "接管" : "重新连接"}
              </button>
            )}
          </div>
        )}
      {(fallbackRenderer || !resumable) && (
        <div className="flex min-h-7 shrink-0 items-center border-b px-2 py-1 text-[11px] cm-banner-warning">
          {fallbackRenderer
            ? "Ghostty Web 加载失败，当前使用兼容终端"
            : "当前电脑镜像较旧，刷新后不能恢复终端进程"}
        </div>
      )}
      {clipboardError && (
        <div className="flex min-h-8 shrink-0 items-center gap-2 border-b px-2 py-1 text-xs cm-banner-danger">
          <span>{clipboardError}</span>
          <button
            type="button"
            className="cm-button ml-auto"
            onClick={() => setClipboardError(null)}
          >
            关闭
          </button>
        </div>
      )}
      {/* 平板保留原单行工具栏；手机使用两行独立滚动区，按使用频率排列快捷键。 */}
      <div
        className="cm-terminal-touch-toolbar cm-workspace-terminal-touch-toolbar shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-2 py-1"
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="cm-terminal-touch-tablet-row flex min-w-0 flex-1 items-center gap-1">
          <div className="cm-terminal-touch-tablet-key-list flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <TouchKeyButton onPress={() => sendTouchKey("escape")}>Esc</TouchKeyButton>
            <TouchKeyButton onPress={() => sendTouchKey("tab")}>Tab</TouchKeyButton>
            <TouchKeyButton onPress={() => sendTouchKey("home")}>Home</TouchKeyButton>
            <TouchKeyButton onPress={() => sendTouchKey("end")}>End</TouchKeyButton>
            <TouchKeyButton onPress={() => sendTouchKey("interrupt")}>Ctrl+C</TouchKeyButton>
            <TouchKeyButton disabled={state !== "connected"} onPress={() => void pasteClipboard()}>
              <ClipboardPaste size={13} /> 粘贴
            </TouchKeyButton>
            <TouchKeyButton label="上方向键" onPress={() => sendTouchKey("up")}>
              <ArrowUp size={13} />
            </TouchKeyButton>
            <TouchKeyButton label="下方向键" onPress={() => sendTouchKey("down")}>
              <ArrowDown size={13} />
            </TouchKeyButton>
            <TouchKeyButton label="左方向键" onPress={() => sendTouchKey("left")}>
              <ArrowLeft size={13} />
            </TouchKeyButton>
            <TouchKeyButton label="右方向键" onPress={() => sendTouchKey("right")}>
              <ArrowRight size={13} />
            </TouchKeyButton>
            <TouchKeyButton label="回车键" onPress={() => sendTouchKey("enter")}>
              <CornerDownLeft size={13} />
            </TouchKeyButton>
          </div>
          <TouchKeyboardButton
            allowed={keyboardAllowed}
            onToggle={() => applyKeyboardAllowed(!keyboardAllowedRef.current)}
          />
        </div>
        <TerminalTouchPhoneRows
          shiftArmed={touchShiftArmed}
          keyboardAllowed={keyboardAllowed}
          pasteDisabled={state !== "connected"}
          onShiftToggle={() => applyTouchShift(!touchShiftArmedRef.current)}
          onKey={sendTouchKey}
          onPaste={() => void pasteClipboard()}
          onKeyboardToggle={() => applyKeyboardAllowed(!keyboardAllowedRef.current)}
        />
      </div>
      <div className="cm-terminal-scroll-surface relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Base UI 自带 500ms 触摸长按菜单，会与 Canvas 文字选择竞争；触屏使用下方
            快捷栏和选区浮层，鼠标设备继续保留右键菜单。 */}
        <ContextMenu disabled={coarsePointer}>
          <ContextMenuTrigger className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div
              ref={setTerminalContainer}
              data-terminal-renderer
              onTouchStart={() => setBlankMenuPoint(null)}
              className="relative h-full min-h-0 min-w-0 overflow-hidden p-1 font-terminal text-[14px] caret-transparent"
              style={{
                backgroundColor: getThemeDefinition(themeId).terminal.background,
                colorScheme: "dark",
                visibility: contentReady ? "visible" : "hidden",
              }}
            />
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem disabled={!hasSelection} onClick={() => void copySelection()}>
              <Copy size={13} />
              <span>复制</span>
              <span className="ml-auto text-[10px] text-zinc-500">Ctrl+C</span>
            </ContextMenuItem>
            <ContextMenuItem disabled={state !== "connected"} onClick={() => void pasteClipboard()}>
              <ClipboardPaste size={13} />
              <span>粘贴</span>
              <span className="ml-auto text-[10px] text-zinc-500">Ctrl+V</span>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {!isPhone && scrollbarAvailable && (
          <TerminalScrollbar
            state={scrollbarPosition}
            disabled={remoteScrollPositionSupported && state !== "connected"}
            onSeek={seekTerminalHistory}
            onInteractionEnd={focusTerminalLater}
          />
        )}
        {isPhone && (touchSelectionActive || blankMenuPoint) && (
          <TerminalTouchActionMenu
            host={terminalHost}
            anchor={touchSelectionActive ? selectionAnchor : blankMenuPoint}
            selectionActive={touchSelectionActive}
            hasSelection={hasSelection}
            canPaste={state === "connected"}
            label={touchSelectionActive ? "终端文字选择" : "终端粘贴"}
            onCopy={() => void copySelection()}
            onPaste={() => void pasteClipboard()}
            onCancel={cancelTouchSelection}
          />
        )}
        {clipboardFallback && (
          <TerminalClipboardFallbackPanel
            value={clipboardFallback}
            canPaste={state === "connected"}
            onClose={() => {
              setClipboardFallback(null);
              focusTerminalLater();
            }}
            onSubmit={(text) => {
              if (stateRef.current !== "connected") return;
              rendererRef.current?.paste(text);
              setClipboardFallback(null);
              setBlankMenuPoint(null);
              focusTerminalLater();
            }}
          />
        )}
        {scrollError && (
          <span
            role="status"
            className="absolute bottom-14 left-1/2 z-20 -translate-x-1/2 rounded bg-zinc-900 px-3 py-1 text-xs text-zinc-300"
          >
            {scrollError}
          </span>
        )}
        {!touchSelectionActive && (showScrollToBottom || remoteInScrollback) && (
          <button
            ref={scrollToBottomButtonRef}
            type="button"
            aria-label="回到底部"
            title="回到底部"
            disabled={scrollPending || (remoteInScrollback && state !== "connected")}
            className="cm-button cm-terminal-scroll-bottom absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full px-3 shadow-lg backdrop-blur-sm"
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => activateScrollToBottom(event.detail === 0)}
          >
            <ArrowDown size={12} aria-hidden="true" />
            <span>{scrollPending ? "返回中…" : "回到底部"}</span>
          </button>
        )}
      </div>
    </div>
  );
}
