import { useRef, useState } from "react";
import { ClipboardPaste, Copy, X } from "lucide-react";

export type TerminalClipboardFallback = { mode: "copy"; text: string } | { mode: "paste" };

export function TerminalTouchActionMenu({
  host,
  anchor,
  selectionActive,
  hasSelection,
  canPaste,
  label,
  onCopy,
  onPaste,
  onCancel,
}: {
  host: HTMLElement | null;
  anchor: { x: number; y: number } | null;
  selectionActive: boolean;
  hasSelection: boolean;
  canPaste: boolean;
  label: string;
  onCopy: () => void;
  onPaste: () => void;
  onCancel: () => void;
}) {
  if (!host || !anchor) return null;
  const rect = host.getBoundingClientRect();
  const halfWidth = selectionActive ? 67 : 43;
  const left = Math.max(halfWidth + 4, Math.min(anchor.x - rect.left, rect.width - halfWidth - 4));
  const desiredTop = anchor.y - rect.top > 54 ? anchor.y - rect.top - 48 : anchor.y - rect.top + 22;
  const top = Math.max(4, Math.min(desiredTop, rect.height - 30));
  return (
    <div
      role="toolbar"
      aria-label={label}
      className="cm-terminal-selection-actions absolute z-30 -translate-x-1/2 items-center"
      style={{ left, top }}
    >
      {selectionActive && (
        <button
          type="button"
          className="cm-button"
          disabled={!hasSelection}
          onPointerDown={(event) => event.preventDefault()}
          onClick={onCopy}
        >
          <Copy size={12} aria-hidden="true" />
          复制
        </button>
      )}
      <button
        type="button"
        className="cm-button"
        disabled={!canPaste}
        onPointerDown={(event) => event.preventDefault()}
        onClick={onPaste}
      >
        <ClipboardPaste size={12} aria-hidden="true" />
        粘贴
      </button>
      <button
        type="button"
        className="cm-button"
        aria-label="关闭操作菜单"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onCancel}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

export function TerminalClipboardFallbackPanel({
  value,
  canPaste,
  onClose,
  onSubmit,
}: {
  value: TerminalClipboardFallback;
  canPaste: boolean;
  onClose: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const copying = value.mode === "copy";
  return (
    <div className="cm-terminal-clipboard-fallback absolute inset-0 z-40 flex items-end justify-center p-2">
      <div className="cm-terminal-clipboard-panel w-full rounded-lg p-3">
        <div className="mb-2 flex items-center justify-between gap-2 text-xs">
          <span>{copying ? "使用系统复制" : "使用系统粘贴"}</span>
          <button type="button" className="cm-button" onClick={onClose} aria-label="关闭剪贴板面板">
            <X size={13} aria-hidden="true" />
          </button>
        </div>
        <textarea
          ref={textarea}
          className="cm-input cm-terminal-clipboard-textarea w-full resize-none p-2 text-xs"
          rows={3}
          aria-label={copying ? "待复制的终端文字" : "待粘贴到终端的文字"}
          readOnly={copying}
          value={copying ? value.text : draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => {
            if (copying) event.currentTarget.select();
          }}
          placeholder={copying ? undefined : "点按此处，长按选择系统粘贴"}
        />
        <div className="mt-2 flex justify-end gap-2">
          {copying ? (
            <button
              type="button"
              className="cm-button"
              onClick={() => {
                textarea.current?.focus();
                textarea.current?.select();
              }}
            >
              全选
            </button>
          ) : (
            <button
              type="button"
              className="cm-button"
              disabled={!draft || !canPaste}
              onClick={() => onSubmit(draft)}
            >
              发送到终端
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
