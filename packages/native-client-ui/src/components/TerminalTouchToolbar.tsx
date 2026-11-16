import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  CornerDownLeft,
  Keyboard,
  KeyboardOff,
} from "lucide-react";

import type { TerminalTouchKey } from "../lib/terminal-keybindings";

/** 触屏工具栏按键不接管焦点，避免软键盘因按钮点击反复收起、升起。 */
export function TouchKeyButton({
  children,
  label,
  className,
  pressed,
  disabled,
  onPress,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
  pressed?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className={`cm-button shrink-0${className ? ` ${className}` : ""}`}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

export function TouchKeyboardButton({
  allowed,
  disabled,
  onToggle,
}: {
  allowed: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="cm-button cm-terminal-keyboard-toggle w-[72px] shrink-0"
      aria-pressed={allowed}
      aria-label={allowed ? "隐藏键盘" : "键盘"}
      title={allowed ? "隐藏键盘" : "显示键盘"}
      disabled={disabled}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onToggle}
    >
      {allowed ? (
        <KeyboardOff size={13} className="shrink-0" aria-hidden="true" />
      ) : (
        <Keyboard size={13} className="shrink-0" aria-hidden="true" />
      )}
      <span>键盘</span>
    </button>
  );
}

export function TerminalTouchPhoneRows({
  disabled = false,
  pasteDisabled = false,
  keyboardDisabled = false,
  shiftArmed,
  keyboardAllowed,
  onShiftToggle,
  onKey,
  onPaste,
  onKeyboardToggle,
}: {
  disabled?: boolean;
  pasteDisabled?: boolean;
  keyboardDisabled?: boolean;
  shiftArmed: boolean;
  keyboardAllowed: boolean;
  onShiftToggle: () => void;
  onKey: (key: TerminalTouchKey) => void;
  onPaste: () => void;
  onKeyboardToggle: () => void;
}) {
  const key = (
    value: TerminalTouchKey,
    children: ReactNode,
    options: { className?: string; label?: string } = {},
  ) => (
    <TouchKeyButton
      className={options.className}
      label={options.label}
      disabled={disabled}
      onPress={() => onKey(value)}
    >
      {children}
    </TouchKeyButton>
  );

  return (
    <div className="cm-terminal-touch-phone-rows min-w-0 flex-1">
      <div className="cm-terminal-touch-primary-key-list flex min-w-0 items-center gap-1 overflow-x-auto">
        {key("escape", "Esc")}
        {key("tab", "Tab")}
        {key("@", "@", { className: "cm-terminal-key-at" })}
        {key("interrupt", "Ctrl+C", { className: "cm-terminal-key-interrupt" })}
        <TouchKeyButton
          className="cm-terminal-key-paste"
          disabled={disabled || pasteDisabled}
          onPress={onPaste}
        >
          <ClipboardPaste size={13} /> 粘贴
        </TouchKeyButton>
        {key("home", "Home", { className: "cm-terminal-key-home" })}
        {key("up", <ArrowUp size={13} />, { label: "上方向键" })}
        {key("end", "End")}
        {key("pageUp", "PG UP")}
        {key("backspace", "退格", {
          className: "cm-terminal-key-backspace",
          label: "退格键",
        })}
        {key("enter", <CornerDownLeft size={13} />, {
          className: "cm-terminal-key-enter",
          label: "回车键",
        })}
      </div>
      <div className="cm-terminal-touch-secondary-key-list flex min-w-0 items-center gap-1 overflow-x-auto">
        <TouchKeyButton
          className="cm-terminal-shift-toggle"
          pressed={shiftArmed}
          disabled={disabled}
          onPress={onShiftToggle}
        >
          Shift
        </TouchKeyButton>
        {key("/", "/", { className: "cm-terminal-key-symbol" })}
        {key("~", "~", { className: "cm-terminal-key-symbol" })}
        {key("-", "-", { className: "cm-terminal-key-symbol" })}
        {key("=", "=", { className: "cm-terminal-key-symbol" })}
        {key("*", "*", { className: "cm-terminal-key-symbol" })}
        {key("left", <ArrowLeft size={13} />, {
          className: "cm-terminal-key-left",
          label: "左方向键",
        })}
        {key("down", <ArrowDown size={13} />, {
          className: "cm-terminal-key-down",
          label: "下方向键",
        })}
        {key("right", <ArrowRight size={13} />, { label: "右方向键" })}
        {key("pageDown", "PG DW", { className: "cm-terminal-key-page-down" })}
        {key("delete", "Delete", { label: "Delete 键" })}
        <TouchKeyboardButton
          allowed={keyboardAllowed}
          disabled={disabled || keyboardDisabled}
          onToggle={onKeyboardToggle}
        />
      </div>
    </div>
  );
}
