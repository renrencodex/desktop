export interface TerminalKeyEvent {
  type: string;
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?(key: string): boolean;
}

function clipboardShortcutKey(event: TerminalKeyEvent): "c" | "v" | null {
  const letter = event.key.toLowerCase();
  if (letter === "c" || letter === "v") return letter;
  // Latin remaps (including Dvorak J/K), punctuation and unidentified keys must
  // never inherit QWERTY shortcuts. Only a single non-Latin letter may fall back.
  if (!/^\p{Letter}$/u.test(event.key) || /\p{Script=Latin}/u.test(event.key)) return null;
  // Prefer the browser's virtual key: a supplied non-C/V key must not be
  // overridden by its physical position. Zero means no virtual key is available.
  if (event.keyCode !== undefined && event.keyCode !== 0)
    return event.keyCode === 67 ? "c" : event.keyCode === 86 ? "v" : null;
  return event.code === "KeyC" ? "c" : event.code === "KeyV" ? "v" : null;
}

/**
 * 有选区时 Ctrl/Cmd+C 由宿主复制；无选区的 Ctrl+C 仍发送 ETX。
 */
export function shouldCopyTerminalSelection(
  event: TerminalKeyEvent,
  hasSelection: boolean,
): boolean {
  return (
    hasSelection &&
    terminalKeyAction(event, {
      mac: true,
      hasSelection,
      applicationCursorKeys: false,
      alternateScreen: false,
    }).kind === "copy"
  );
}

/**
 * 传统终端把 Shift+Enter 和 Enter 编码成同一个 CR，TUI 输入框无法区分提交与换行。
 * 改发 LF（与 Ctrl+J 相同的字节）：Codex、Claude Code 等 CLI 都以 Ctrl+J 作为无需配置
 * 的换行输入，而 Shell 的 readline 仍把 LF 视为提交，非 TUI 场景行为不变。
 */
export function shiftEnterNewlineSequence(event: TerminalKeyEvent): string | null {
  if (event.type !== "keydown" || !event.shiftKey) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  // 主键盘和小键盘的回车都上报 key="Enter"，与键盘布局无关。
  return event.key === "Enter" ? "\n" : null;
}

/** Shift+Tab 在终端中使用标准的反向 Tab（Backtab）CSI 序列。 */
export function shiftTabSequence(event: TerminalKeyEvent): string | null {
  if (event.type !== "keydown" || !event.shiftKey) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  return event.key === "Tab" || event.code === "Tab" ? "\u001b[Z" : null;
}

export type TerminalCursorKey = "up" | "down" | "left" | "right" | "home" | "end";

const CURSOR_KEY_FINAL: Record<TerminalCursorKey, string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
  home: "H",
  end: "F",
};

/**
 * 应用光标键模式（DECCKM）下 TUI 等待 SS3 前缀，普通模式等待 CSI。手机工具栏的方向键和
 * Home/End 必须按当前模式发送，与真实终端键盘保持一致。
 */
export function cursorKeySequence(key: TerminalCursorKey, applicationMode: boolean): string {
  return `\u001b${applicationMode ? "O" : "["}${CURSOR_KEY_FINAL[key]}`;
}

export type TerminalTouchKey =
  | "escape"
  | "tab"
  | "home"
  | "end"
  | "interrupt"
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "/"
  | "~"
  | "-"
  | "="
  | "@"
  | ":"
  | "*"
  | "pageUp"
  | "pageDown"
  | "backspace"
  | "delete";

const TOUCH_CURSOR_KEYS = new Set<TerminalTouchKey>(["home", "end", "up", "down", "left", "right"]);

const SHIFTED_PRINTABLE: Partial<Record<TerminalTouchKey, string>> = {
  "/": "?",
  "-": "_",
  "=": "+",
};

/**
 * 手机终端快捷栏模拟真实终端按键。Shift 是一次性修饰状态；带修饰的光标键统一使用
 * xterm CSI modifier 参数，不能继续使用仅容纳单字符终值的 DECCKM/SS3 形式。
 */
export function terminalTouchKeySequence(
  key: TerminalTouchKey,
  shifted: boolean,
  applicationMode: boolean,
): string {
  if (TOUCH_CURSOR_KEYS.has(key)) {
    const cursorKey = key as TerminalCursorKey;
    return shifted
      ? `\u001b[1;2${CURSOR_KEY_FINAL[cursorKey]}`
      : cursorKeySequence(cursorKey, applicationMode);
  }

  switch (key) {
    case "escape":
      return "\u001b";
    case "tab":
      return shifted ? "\u001b[Z" : "\t";
    case "interrupt":
      return "\u0003";
    case "enter":
      return shifted ? "\n" : "\r";
    case "pageUp":
      return shifted ? "\u001b[5;2~" : "\u001b[5~";
    case "pageDown":
      return shifted ? "\u001b[6;2~" : "\u001b[6~";
    case "backspace":
      return "\u007f";
    case "delete":
      return shifted ? "\u001b[3;2~" : "\u001b[3~";
    default:
      return shifted ? (SHIFTED_PRINTABLE[key] ?? key) : key;
  }
}

export interface TerminalKeyboardContext {
  mac: boolean;
  hasSelection: boolean;
  applicationCursorKeys: boolean;
  /** null means the authoritative remote screen is not ready; never guess from the outer PTY. */
  alternateScreen: boolean | null;
}

export type TerminalKeyAction =
  | { kind: "pass" }
  | { kind: "send"; data: string }
  | { kind: "copy" }
  | { kind: "paste" }
  | { kind: "native-paste" }
  | { kind: "history"; pages: -1 | 1 };

const NAVIGATION_FINAL: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};
const TILDE_KEYS: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};
/** Only known shortcuts are encoded here. Text, IME and unknown protocols stay with the renderer. */
export function terminalKeyAction(
  event: TerminalKeyEvent,
  context: TerminalKeyboardContext,
): TerminalKeyAction {
  const pass: TerminalKeyAction = { kind: "pass" };
  if (
    event.type !== "keydown" ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.key === "Dead" ||
    event.key === "Process" ||
    event.getModifierState?.("AltGraph")
  )
    return pass;
  const { ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift, key } = event;
  const letter = key.toLowerCase();
  if (!alt && ((ctrl && !meta) || (context.mac && meta && !ctrl))) {
    const clipboardKey = clipboardShortcutKey(event);
    if (clipboardKey === "c") {
      if (meta || shift || context.hasSelection) return { kind: "copy" };
      return { kind: "send", data: "\x03" };
    }
    if (clipboardKey === "v") return { kind: context.mac && ctrl ? "paste" : "native-paste" };
  }
  if (shift && key === "Insert" && !ctrl && !meta && !alt)
    return { kind: context.mac ? "paste" : "native-paste" };
  if (meta) return pass;
  // Ctrl+Alt printable keys may be AltGr on layouts that do not expose AltGraph.
  if (ctrl && alt && key.length === 1) return pass;
  if (
    shift &&
    !ctrl &&
    !alt &&
    (key === "PageUp" || key === "PageDown") &&
    context.alternateScreen !== true
  )
    return { kind: "history", pages: key === "PageUp" ? 1 : -1 };

  const special = shiftEnterNewlineSequence(event) ?? shiftTabSequence(event);
  if (special !== null) return { kind: "send", data: special };
  if (ctrl && !alt && !shift) {
    const alias = ({ i: "\t", m: "\r", "[": "\x1b" } as Record<string, string>)[letter];
    if (alias !== undefined) return { kind: "send", data: alias };
  }
  const modifier = 1 + Number(shift) + 2 * Number(alt) + 4 * Number(ctrl);
  const final = NAVIGATION_FINAL[key];
  if (final)
    return {
      kind: "send",
      data:
        modifier === 1
          ? `\x1b${context.applicationCursorKeys ? "O" : "["}${final}`
          : `\x1b[1;${modifier}${final}`,
    };
  if (/^F[1-4]$/.test(key)) {
    const final = "PQRS"[Number(key.slice(1)) - 1];
    return { kind: "send", data: modifier === 1 ? `\x1bO${final}` : `\x1b[1;${modifier}${final}` };
  }
  const number = TILDE_KEYS[key];
  if (number !== undefined)
    return { kind: "send", data: `\x1b[${number}${modifier === 1 ? "" : `;${modifier}`}~` };
  if (alt && !ctrl && !context.mac && /^[\x20-\x7e]$/.test(key))
    return { kind: "send", data: `\x1b${key}` };
  // Ghostty maps keypad codes before printable text. NumLock-on digits must stay digits.
  if (event.code.startsWith("Numpad") && !ctrl && !alt && /^[0-9.,+*/=-]$/.test(key))
    return { kind: "send", data: key };
  return pass;
}

const TOUCH_KEY_NAMES: Partial<Record<TerminalTouchKey, string>> = {
  escape: "Escape",
  tab: "Tab",
  home: "Home",
  end: "End",
  interrupt: "c",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  enter: "Enter",
  pageUp: "PageUp",
  pageDown: "PageDown",
  backspace: "Backspace",
  delete: "Delete",
};

export function terminalTouchKeyAction(
  key: TerminalTouchKey,
  shifted: boolean,
  context: TerminalKeyboardContext,
): TerminalKeyAction {
  const action = terminalKeyAction(
    {
      type: "keydown",
      key: TOUCH_KEY_NAMES[key] ?? key,
      code: "",
      shiftKey: shifted,
      ctrlKey: key === "interrupt",
      altKey: false,
      metaKey: false,
    },
    context,
  );
  return action.kind === "pass"
    ? { kind: "send", data: terminalTouchKeySequence(key, shifted, context.applicationCursorKeys) }
    : action;
}

export function terminalHistoryPageOffset(
  position: { offsetLines: number; viewportRows: number; historyLines: number },
  pages: -1 | 1,
): number {
  return Math.max(
    0,
    Math.min(
      position.historyLines,
      position.offsetLines + pages * Math.max(1, position.viewportRows - 1),
    ),
  );
}

export interface TerminalKeyboardBinding {
  context(): TerminalKeyboardContext;
  isReadOnly(): boolean;
  send(data: string): void;
  copy(): void;
  paste(): void;
  history(pages: -1 | 1): void;
}

/** Capture above both renderers: their custom-handler boolean conventions are opposite. */
export function bindTerminalKeyboard(container: HTMLElement, binding: TerminalKeyboardBinding) {
  let composing = false;
  const dispatch = (action: TerminalKeyAction) => {
    switch (action.kind) {
      case "copy":
        binding.copy();
        break;
      case "history":
        binding.history(action.pages);
        break;
      case "paste":
        if (!binding.isReadOnly()) binding.paste();
        break;
      case "send":
        if (!binding.isReadOnly()) binding.send(action.data);
        break;
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || composing) return;
    const action = terminalKeyAction(event, binding.context());
    if (action.kind === "pass") return;
    // Native paste needs the browser default but must not emit ^V/Insert as well.
    if (action.kind !== "native-paste" || binding.isReadOnly()) event.preventDefault();
    event.stopImmediatePropagation();
    dispatch(action);
  };
  const startComposition = () => {
    composing = true;
  };
  const endComposition = () => {
    composing = false;
  };
  container.addEventListener("keydown", onKeyDown, true);
  container.addEventListener("compositionstart", startComposition, true);
  container.addEventListener("compositionend", endComposition, true);
  return {
    sendKey: (key: TerminalTouchKey, shifted: boolean) =>
      dispatch(terminalTouchKeyAction(key, shifted, binding.context())),
    dispose() {
      container.removeEventListener("keydown", onKeyDown, true);
      container.removeEventListener("compositionstart", startComposition, true);
      container.removeEventListener("compositionend", endComposition, true);
    },
  };
}

/** An async clipboard read may not outlive even a temporary focus/visibility change. */
export function guardTerminalClipboardRead(container: HTMLElement) {
  const document = container.ownerDocument;
  const window = document.defaultView;
  const initialFocus = document.activeElement;
  let valid = !document.hidden && document.hasFocus();
  const invalidate = () => {
    valid = false;
  };
  const onFocus = (event: FocusEvent) => {
    if (event.target !== initialFocus && !container.contains(event.target as Node | null))
      invalidate();
  };
  const onVisibility = () => {
    if (document.hidden) invalidate();
  };
  document.addEventListener("focusin", onFocus, true);
  document.addEventListener("visibilitychange", onVisibility);
  window?.addEventListener("blur", invalidate);
  return {
    valid: () =>
      valid &&
      container.isConnected &&
      !document.hidden &&
      document.hasFocus() &&
      (document.activeElement === initialFocus || container.contains(document.activeElement)),
    dispose() {
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("visibilitychange", onVisibility);
      window?.removeEventListener("blur", invalidate);
    },
  };
}
