/** Normalize clipboard line endings to the single carriage return expected by a PTY. */
export function normalizeTerminalPaste(data: string): string {
  return data.replace(/\r?\n/g, "\r");
}

/**
 * Ghostty 0.4 forwards native clipboard text without normalizing line endings.
 * Capture paste before Ghostty's own listeners so CRLF is not sent as two enters.
 */
export function bindNormalizedTerminalPaste(
  host: HTMLElement,
  options: { isReadOnly(): boolean; paste(data: string): void },
) {
  const onPaste = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    const data = event.clipboardData.getData("text/plain");
    event.preventDefault();
    event.stopImmediatePropagation();
    if (data && !options.isReadOnly()) options.paste(normalizeTerminalPaste(data));
  };

  host.addEventListener("paste", onPaste, true);
  return {
    dispose() {
      host.removeEventListener("paste", onPaste, true);
    },
  };
}
