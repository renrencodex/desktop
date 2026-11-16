"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  rescueServerMessageSchema,
  type RescueClientMessage,
  type RescueSession,
} from "@cloud-machine/client-contracts";
import {
  TERMINAL_FONT_FALLBACK,
  TERMINAL_FONT_SIZE,
  onTerminalFontsLoaded,
  terminalFontFamily,
} from "@cloud-machine/workspace-ui/terminal-font";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { api } from "../lib/api";
import { base64ToBytes } from "../lib/base64";
import { desktopLayoutGate } from "../lib/desktop-layout-state";
import { sendRescueInput } from "../lib/rescue-input";
import { PHONE_MEDIA_QUERY, getMediaQuerySnapshot, useMediaQuery } from "../lib/responsive";
import { guardTerminalClipboardRead, type TerminalTouchKey } from "../lib/terminal-keybindings";
import {
  createTerminalRenderer,
  type TerminalRenderer,
  type TerminalKeyboardHost,
} from "../lib/terminal-renderer";
import type { TerminalScrollbarState } from "../lib/terminal-scrollbar-model";
import { getThemeDefinition } from "../lib/themes";
import { useThemeStore } from "../stores/theme";
import { userErrorMessage } from "../lib/user-error";
import { gatewayWebSocketUrl, useClientHost } from "../host";
import { isApiError } from "@cloud-machine/api-client";
import { TerminalTouchPhoneRows } from "./TerminalTouchToolbar";
import {
  TerminalClipboardFallbackPanel,
  TerminalTouchActionMenu,
  type TerminalClipboardFallback,
} from "./TerminalTouchClipboardUI";
import { TerminalScrollbar } from "./TerminalScrollbar";

const recentRescueCloses = new Map<string, number>();
const REOPEN_WINDOW_MS = 5_000;
const REOPEN_DELAYS_MS = [150, 300, 500, 750, 1_000, 1_000];
const EMPTY_SCROLL_POSITION: TerminalScrollbarState = {
  offsetLines: 0,
  historyLines: 0,
  viewportRows: 1,
  alternateScreen: false,
};

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function RescueTerminalDialog({
  machineId,
  onClose,
}: {
  machineId: string;
  onClose: () => void;
}) {
  const { platform } = useClientHost();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const renderer = useRef<TerminalRenderer | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const connectedRef = useRef(false);
  const keyboardHostRef = useRef<TerminalKeyboardHost>({ copy() {}, paste() {} });
  const themeId = useThemeStore((state) => state.themeId);
  const themeRef = useRef(themeId);
  useEffect(() => {
    themeRef.current = themeId;
  }, [themeId]);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("正在连接…");
  const [retryable, setRetryable] = useState(false);
  const retrying = useRef(false);
  const retry = useRef<(() => void) | null>(null);
  const [connected, setConnected] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const keyboardRef = useRef(false);
  const [touchShiftArmed, setTouchShiftArmed] = useState(false);
  const touchShiftArmedRef = useRef(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [touchSelectionActive, setTouchSelectionActive] = useState(false);
  const [selectionAnchor, setSelectionAnchor] = useState<{ x: number; y: number } | null>(null);
  const [clipboardFallback, setClipboardFallback] = useState<TerminalClipboardFallback | null>(
    null,
  );
  const [blankMenuPoint, setBlankMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const scrollSessionKey = `${machineId}:${attempt}`;
  const [scrollPositionState, setScrollPositionState] = useState({
    key: scrollSessionKey,
    value: EMPTY_SCROLL_POSITION,
  });
  const scrollPosition =
    scrollPositionState.key === scrollSessionKey
      ? scrollPositionState.value
      : EMPTY_SCROLL_POSITION;
  const isPhone = useMediaQuery(PHONE_MEDIA_QUERY);
  const syncScrollPosition = useCallback(
    (value = renderer.current) => {
      if (!value) return;
      const next = value.getScrollState();
      setScrollPositionState((current) =>
        current.key === scrollSessionKey &&
        current.value.offsetLines === next.offsetLines &&
        current.value.historyLines === next.historyLines &&
        current.value.viewportRows === next.viewportRows &&
        current.value.alternateScreen === next.alternateScreen
          ? current
          : { key: scrollSessionKey, value: next },
      );
    },
    [scrollSessionKey],
  );
  const applyKeyboardAllowed = useCallback(
    (value: boolean) => {
      keyboardRef.current = value;
      setKeyboard(value);
      const currentRenderer = renderer.current;
      if (!currentRenderer) return;
      currentRenderer.setSoftKeyboardAllowed(value);
      if (value) {
        // 移动浏览器只允许在当前用户手势中呼出软键盘。
        currentRenderer.focus();
        return;
      }
      // 已弹出的软键盘不会因 inputmode 变化自动消失：先让隐藏输入框失焦，
      // 下一帧再以 inputmode=none 恢复终端焦点和外接键盘输入。
      const view = container?.ownerDocument.defaultView;
      const element = container?.ownerDocument.activeElement;
      if (view && element instanceof view.HTMLElement && container.contains(element))
        element.blur();
      if (!view) {
        currentRenderer.focus();
        return;
      }
      view.requestAnimationFrame(() => {
        if (renderer.current === currentRenderer && container?.isConnected) currentRenderer.focus();
      });
    },
    [container],
  );
  const send = (message: RescueClientMessage) => {
    if (message.type === "resize" && desktopLayoutGate.isSuspended()) return false;
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) {
      ws.send(JSON.stringify(message));
      return true;
    }
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    return false;
  };
  useEffect(() => {
    // Popup content is portalled and may mount after the dialog's first effect.
    if (!container) return;
    const host = container;
    // A rescue connection always owns a fresh screen, including after retry.
    host.replaceChildren();
    const controller = new AbortController();
    let disposed = false;
    let session: RescueSession | null = null;
    let ws: WebSocket | null = null;
    let closeRequest: Promise<void> | null = null;
    const closeSession = () => {
      if (!session) return Promise.resolve();
      recentRescueCloses.set(machineId, Date.now() + REOPEN_WINDOW_MS);
      if (!closeRequest)
        closeRequest = api.machines
          .closeRescueSession(machineId, session.sessionId)
          .catch((error) => {
            closeRequest = null;
            throw error;
          });
      return closeRequest;
    };
    let term: TerminalRenderer | null = null;
    let observer: ResizeObserver | null = null;
    let postOpenFrame: number | null = null;
    let layoutFrame = 0;
    const disposables: Array<{ dispose(): void }> = [];
    let unsubscribeFont: (() => void) | undefined;
    let ended = false;
    const phone = window.matchMedia(PHONE_MEDIA_QUERY);
    const fit = () => {
      if (
        !disposed &&
        term &&
        !desktopLayoutGate.isSuspended() &&
        host.clientWidth &&
        host.clientHeight
      ) {
        term.setFontSize(
          getMediaQuerySnapshot(PHONE_MEDIA_QUERY)
            ? TERMINAL_FONT_SIZE.phone
            : TERMINAL_FONT_SIZE.default,
        );
        term.fit();
        syncScrollPosition(term);
      }
    };
    const stopLayout = desktopLayoutGate.subscribe(() => {
      cancelAnimationFrame(layoutFrame);
      if (!desktopLayoutGate.isSuspended())
        layoutFrame = requestAnimationFrame(() => {
          fit();
          if (!disposed && term && connectedRef.current)
            send({ type: "resize", cols: term.cols, rows: term.rows });
        });
    });
    const end = (notice: string) => {
      if (disposed || ended) return;
      ended = true;
      connectedRef.current = false;
      setConnected(false);
      setRetryable(true);
      setStatus(notice);
      setKeyboard(false);
      keyboardRef.current = false;
      setTouchShiftArmed(false);
      touchShiftArmedRef.current = false;
      setHasSelection(false);
      setTouchSelectionActive(false);
      setSelectionAnchor(null);
      setBlankMenuPoint(null);
      setClipboardFallback(null);
      term?.setReadOnly(true);
      term?.setFocused(false);
      term?.setSoftKeyboardAllowed(false);
      ws?.close();
      void closeSession().catch(() => {});
    };
    retry.current = () => {
      if (disposed || !ended || retrying.current) return;
      retrying.current = true;
      setRetryable(false);
      setStatus("正在连接…");
      ws?.close();
      void closeSession()
        .then(() => {
          if (!disposed) setAttempt((value) => value + 1);
        })
        .catch((error) => {
          if (disposed) return;
          retrying.current = false;
          setRetryable(true);
          setStatus(userErrorMessage(error, "关闭旧连接失败，请重试"));
        });
    };
    retrying.current = false;
    keyboardRef.current = false;
    touchShiftArmedRef.current = false;
    void (async () => {
      term = await createTerminalRenderer(
        host,
        {
          fontFamily: TERMINAL_FONT_FALLBACK,
          fontSize: getMediaQuerySnapshot(PHONE_MEDIA_QUERY)
            ? TERMINAL_FONT_SIZE.phone
            : TERMINAL_FONT_SIZE.default,
          layoutGate: desktopLayoutGate,
          theme: { ...getThemeDefinition(themeRef.current).terminal },
          backend: "xterm",
          keyboardHost: {
            copy: () => keyboardHostRef.current.copy(),
            paste: () => keyboardHostRef.current.paste(),
          },
          onBlankLongPress: (point) => {
            if (getMediaQuerySnapshot(PHONE_MEDIA_QUERY)) setBlankMenuPoint(point);
          },
        },
        controller.signal,
      );
      if (disposed) {
        term.dispose();
        return;
      }
      renderer.current = term;
      term.setReadOnly(true);
      term.setSoftKeyboardAllowed(false);
      fit();
      observer = new ResizeObserver(fit);
      observer.observe(host);
      phone.addEventListener("change", fit);
      window.visualViewport?.addEventListener("resize", fit);
      unsubscribeFont = onTerminalFontsLoaded(
        host,
        getMediaQuerySnapshot(PHONE_MEDIA_QUERY)
          ? TERMINAL_FONT_SIZE.phone
          : TERMINAL_FONT_SIZE.default,
        () => {
          term?.setFontFamily(terminalFontFamily(host));
          fit();
        },
      );
      disposables.push(
        term.onData((data) => {
          sendRescueInput(new TextEncoder().encode(data), send);
        }),
        term.onBinary((data) => sendRescueInput(data, send)),
        term.onResize((size) => send({ type: "resize", ...size })),
        term.onScroll(() => syncScrollPosition(term)),
        term.onSelectionChange(() => {
          if (!term) return;
          const touchActive = term.isTouchSelectionActive();
          setHasSelection(term.hasSelection());
          setTouchSelectionActive(touchActive);
          setSelectionAnchor(touchActive ? term.getTouchSelectionAnchor() : null);
          if (touchActive) setBlankMenuPoint(null);
          if (touchActive && keyboardRef.current) applyKeyboardAllowed(false);
        }),
      );
      const idempotencyKey = crypto.randomUUID();
      for (let retryIndex = 0; ; retryIndex++) {
        controller.signal.throwIfAborted();
        try {
          session = await api.machines.createRescueSession(
            machineId,
            { cols: term.cols, rows: term.rows },
            idempotencyKey,
          );
          recentRescueCloses.delete(machineId);
          break;
        } catch (error) {
          if (
            !isApiError(error) ||
            error.code !== "RESCUE_BUSY" ||
            (recentRescueCloses.get(machineId) ?? 0) <= Date.now() ||
            retryIndex >= REOPEN_DELAYS_MS.length
          )
            throw error;
          setStatus("正在等待上次救援连接结束…");
          await waitForRetry(REOPEN_DELAYS_MS[retryIndex]!, controller.signal);
        }
      }
      if (disposed) {
        await closeSession().catch(() => {});
        return;
      }
      ws = new WebSocket(
        gatewayWebSocketUrl(
          `/machines/${encodeURIComponent(machineId)}/rescue/${session.sessionId}?ticket=${encodeURIComponent(session.ticket)}`,
        ),
      );
      socket.current = ws;
      ws.onmessage = (event) => {
        if (disposed || ended) return;
        try {
          const message = rescueServerMessageSchema.parse(JSON.parse(String(event.data)));
          if (message.type === "opened") {
            connectedRef.current = true;
            setConnected(true);
            setStatus("已连接");
            term!.setReadOnly(false);
            term!.setFocused(true);
            term!.setSoftKeyboardAllowed(keyboardRef.current);
            fit();
            send({ type: "resize", cols: term!.cols, rows: term!.rows });
            term!.focus();
            // The popup may still be settling after its first visible frame.
            postOpenFrame = window.requestAnimationFrame(() => {
              postOpenFrame = null;
              if (disposed || ended || socket.current !== ws || renderer.current !== term) return;
              fit();
              send({ type: "resize", cols: term!.cols, rows: term!.rows });
            });
          } else if (message.type === "output")
            term!.write(base64ToBytes(message.data), () => syncScrollPosition(term));
          else {
            end(message.type === "exit" ? "会话已结束" : "救援连接失败，请重试");
          }
        } catch {
          end("救援连接异常，请重试");
        }
      };
      ws.onerror = () => end("救援连接失败，请确认电脑已启动后重试");
      ws.onclose = () => end("连接已结束，请重试");
    })().catch((error) => {
      if (!disposed) {
        end(userErrorMessage(error, "救援连接失败"));
        ws?.close();
      }
    });
    const pagehide = () => {
      ws?.close();
    };
    window.addEventListener("pagehide", pagehide);
    return () => {
      disposed = true;
      stopLayout();
      cancelAnimationFrame(layoutFrame);
      connectedRef.current = false;
      retry.current = null;
      controller.abort();
      if (postOpenFrame !== null) window.cancelAnimationFrame(postOpenFrame);
      window.removeEventListener("pagehide", pagehide);
      phone.removeEventListener("change", fit);
      window.visualViewport?.removeEventListener("resize", fit);
      observer?.disconnect();
      unsubscribeFont?.();
      for (const disposable of disposables) {
        try {
          disposable.dispose();
        } catch {
          // Continue releasing the remaining resources after a partial teardown.
        }
      }
      ws?.close();
      if (socket.current === ws) socket.current = null;
      try {
        term?.dispose();
      } catch {
        // The host still needs clearing and the server session still needs closing.
      }
      host.replaceChildren();
      if (renderer.current === term) renderer.current = null;
      void closeSession().catch(() => {});
    };
  }, [machineId, attempt, container, applyKeyboardAllowed, syncScrollPosition]);
  const sendTouchKey = (value: TerminalTouchKey) => {
    const shifted = touchShiftArmedRef.current;
    if (shifted) {
      touchShiftArmedRef.current = false;
      setTouchShiftArmed(false);
    }
    renderer.current?.sendKey(value, shifted);
  };
  const toggleKeyboard = () => {
    applyKeyboardAllowed(!keyboardRef.current);
  };
  const pasteClipboard = useCallback(async () => {
    const currentRenderer = renderer.current;
    const currentSocket = socket.current;
    if (
      !connectedRef.current ||
      !currentRenderer ||
      !container ||
      currentSocket?.readyState !== WebSocket.OPEN
    )
      return;
    const guard = guardTerminalClipboardRead(container);
    const valid = () =>
      connectedRef.current &&
      renderer.current === currentRenderer &&
      socket.current === currentSocket &&
      currentSocket.readyState === WebSocket.OPEN &&
      guard.valid();
    try {
      const text = await navigator.clipboard.readText();
      if (!valid()) return;
      if (!text) setClipboardFallback({ mode: "paste" });
      else {
        currentRenderer.paste(text);
        setBlankMenuPoint(null);
      }
    } catch {
      if (valid()) setClipboardFallback({ mode: "paste" });
    } finally {
      guard.dispose();
    }
  }, [container]);
  const copySelection = useCallback(async () => {
    const currentRenderer = renderer.current;
    if (!currentRenderer?.hasSelection() || !container) return;
    const text = currentRenderer.getSelection();
    const guard = guardTerminalClipboardRead(container);
    try {
      await platform.clipboard.writeText(text);
      if (renderer.current !== currentRenderer || !guard.valid()) return;
      if (currentRenderer.isTouchSelectionActive() && currentRenderer.getSelection() === text)
        currentRenderer.clearSelection();
      setBlankMenuPoint(null);
    } catch {
      if (renderer.current === currentRenderer && guard.valid())
        setClipboardFallback({ mode: "copy", text });
    } finally {
      guard.dispose();
    }
  }, [container, platform]);
  useLayoutEffect(() => {
    keyboardHostRef.current = {
      copy: () => void copySelection(),
      paste: () => void pasteClipboard(),
    };
  }, [copySelection, pasteClipboard]);
  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (
          !open &&
          details.reason === "escape-key" &&
          container?.contains(document.activeElement)
        ) {
          details.cancel();
          return;
        }
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="cm-rescue-dialog top-1/2 max-md:translate-x-0 max-md:translate-y-0"
        onKeyDown={(event) => {
          if (event.key === "Escape" && container?.contains(document.activeElement))
            event.stopPropagation();
        }}
      >
        <DialogTitle className="text-sm">救援终端</DialogTitle>
        <div className="flex min-h-6 items-center gap-2">
          <div role="status" className="text-[11px] text-zinc-500">
            {status}
          </div>
          {retryable && (
            <button
              type="button"
              className="cm-button cm-rescue-retry shrink-0"
              onClick={() => retry.current?.()}
            >
              重试
            </button>
          )}
        </div>
        <div
          className="cm-terminal-touch-toolbar cm-rescue-keys shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-2 py-1"
          onContextMenu={(event) => event.preventDefault()}
        >
          <TerminalTouchPhoneRows
            disabled={!connected}
            pasteDisabled={!connected}
            keyboardDisabled={!connected}
            shiftArmed={touchShiftArmed}
            keyboardAllowed={keyboard}
            onShiftToggle={() => {
              const value = !touchShiftArmedRef.current;
              touchShiftArmedRef.current = value;
              setTouchShiftArmed(value);
            }}
            onKey={sendTouchKey}
            onPaste={pasteClipboard}
            onKeyboardToggle={toggleKeyboard}
          />
        </div>
        <div className="relative flex min-h-0 flex-1">
          <div
            ref={setContainer}
            data-terminal-renderer
            className="cm-rescue-terminal min-h-0 flex-1 overflow-hidden font-terminal text-[14px]"
            onTouchStart={() => setBlankMenuPoint(null)}
          />
          {!isPhone && (
            <TerminalScrollbar
              state={scrollPosition}
              onSeek={(offsetLines) => {
                renderer.current?.scrollToOffset(offsetLines);
                syncScrollPosition();
              }}
              onInteractionEnd={() => renderer.current?.focus()}
            />
          )}
          {isPhone && (touchSelectionActive || blankMenuPoint) && (
            <TerminalTouchActionMenu
              host={container}
              anchor={touchSelectionActive ? selectionAnchor : blankMenuPoint}
              selectionActive={touchSelectionActive}
              hasSelection={hasSelection}
              canPaste={connected}
              label={touchSelectionActive ? "救援终端文字选择" : "救援终端粘贴"}
              onCopy={copySelection}
              onPaste={pasteClipboard}
              onCancel={() => {
                renderer.current?.clearSelection();
                setBlankMenuPoint(null);
                renderer.current?.focus();
              }}
            />
          )}
          {clipboardFallback && (
            <TerminalClipboardFallbackPanel
              value={clipboardFallback}
              canPaste={connected}
              onClose={() => {
                setClipboardFallback(null);
                renderer.current?.focus();
              }}
              onSubmit={(text) => {
                if (socket.current?.readyState !== WebSocket.OPEN) return;
                renderer.current?.paste(text);
                setClipboardFallback(null);
                setBlankMenuPoint(null);
                renderer.current?.focus();
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
