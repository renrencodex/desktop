const TRANSIENT_USER_INPUT_EVENTS = ["beforeinput", "input", "paste", "compositionend"] as const;

/**
 * Track the browser event that is currently producing terminal data.
 *
 * A renderer's `onData` also carries terminal-generated protocol replies, such
 * as a TUI's DEC focus report. Those replies must not be treated as keyboard
 * input: doing so can clear an active touch selection while the soft keyboard
 * is being dismissed.
 */
export function bindTerminalUserInputIntent(container: HTMLElement): {
  isCurrent(): boolean;
  dispose(): void;
} {
  let sequence = 0;
  let transient = false;
  const pressedKeys = new Set<string>();
  const mark = () => {
    const markedSequence = ++sequence;
    transient = true;
    queueMicrotask(() => {
      if (sequence === markedSequence) transient = false;
    });
  };
  const keyId = (event: KeyboardEvent) => event.code || event.key;
  const onKeyDown = (event: KeyboardEvent) => {
    pressedKeys.add(keyId(event));
  };
  const onKeyUp = (event: KeyboardEvent) => {
    pressedKeys.delete(keyId(event));
  };
  const clearPressedKeys = () => pressedKeys.clear();

  container.addEventListener("keydown", onKeyDown, true);
  container.addEventListener("keyup", onKeyUp, true);
  container.addEventListener("focusout", clearPressedKeys, true);
  for (const type of TRANSIENT_USER_INPUT_EVENTS) container.addEventListener(type, mark, true);
  return {
    // Some terminal engines emit onData after the keydown microtask checkpoint.
    // Keep hardware-key intent alive until keyup, while IME/input events remain
    // scoped to their event turn so later protocol replies cannot inherit it.
    isCurrent: () => transient || pressedKeys.size > 0,
    dispose: () => {
      sequence++;
      transient = false;
      pressedKeys.clear();
      container.removeEventListener("keydown", onKeyDown, true);
      container.removeEventListener("keyup", onKeyUp, true);
      container.removeEventListener("focusout", clearPressedKeys, true);
      for (const type of TRANSIENT_USER_INPUT_EVENTS)
        container.removeEventListener(type, mark, true);
    },
  };
}
