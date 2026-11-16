/**
 * Ghostty 0.4 cancels every beforeinput on its host and only handles keydown /
 * compositionend. Own native textarea input so mobile keyboards can insert text
 * without a usable keydown. Keep ordinary hardware keys and paste with Ghostty.
 */
export function bindTerminalNativeInput(
  input: HTMLTextAreaElement,
  options: { isReadOnly(): boolean; send(data: string): void },
) {
  let composing = false;
  let compositionAllowed = false;
  let committed: string | null = null;
  let commitTimer: ReturnType<typeof setTimeout> | undefined;

  const clearCommit = () => {
    clearTimeout(commitTimer);
    commitTimer = undefined;
    committed = null;
  };
  const send = (data: string) => {
    if (data && !options.isReadOnly()) options.send(data);
  };
  const textFor = (event: InputEvent): string => {
    switch (event.inputType) {
      case "insertText":
      case "insertReplacementText":
      case "insertFromComposition":
        return event.data ?? input.value;
      case "insertLineBreak":
      case "insertParagraph":
        return "\r";
      case "deleteContentBackward":
        return "\u007f";
      case "deleteContentForward":
        return "\u001b[3~";
      default:
        return "";
    }
  };
  const isCommittedInput = (event: InputEvent) =>
    committed !== null &&
    (event.inputType === "insertText" ||
      event.inputType === "insertFromComposition" ||
      event.inputType === "insertCompositionText") &&
    event.data === committed;

  const onBeforeInput = (event: InputEvent) => {
    // Stop Ghostty's host listener, not the browser's native composition editing.
    event.stopPropagation();
    if (options.isReadOnly()) {
      compositionAllowed = false;
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (composing || event.isComposing) return;
    if (!event.cancelable) return; // The subsequent input event owns this edit.
    event.preventDefault();
    if (!isCommittedInput(event)) send(textFor(event));
    clearCommit();
    input.value = "";
  };
  const onInput = (event: InputEvent) => {
    event.stopPropagation();
    if (options.isReadOnly()) compositionAllowed = false;
    if (composing || event.isComposing) return;
    if (!isCommittedInput(event)) send(textFor(event));
    clearCommit();
    input.value = "";
  };
  const onCompositionStart = (event: CompositionEvent) => {
    event.stopPropagation();
    clearCommit();
    composing = true;
    compositionAllowed = !options.isReadOnly();
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    event.stopPropagation(); // This adapter, not Ghostty, sends the committed text.
    composing = false;
    if (compositionAllowed) send(event.data);
    compositionAllowed = false;
    // Engines can emit a final input after compositionend. Suppress only the
    // same commit in this event sequence, never a later identical character.
    clearCommit();
    committed = event.data;
    commitTimer = setTimeout(() => {
      clearCommit();
      input.value = "";
    }, 0);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (composing || event.isComposing || event.keyCode === 229) event.stopPropagation();
    else clearCommit();
  };
  input.addEventListener("beforeinput", onBeforeInput);
  input.addEventListener("input", onInput as EventListener);
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);
  input.addEventListener("keydown", onKeyDown);
  const reset = () => {
    compositionAllowed = false;
    clearCommit();
    input.value = "";
  };
  return {
    // Invalidate an in-flight composition on disconnect/reset, even if the
    // terminal becomes writable again before the IME eventually commits it.
    reset,
    dispose() {
      reset();
      input.removeEventListener("beforeinput", onBeforeInput);
      input.removeEventListener("input", onInput as EventListener);
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
      input.removeEventListener("keydown", onKeyDown);
    },
  };
}
