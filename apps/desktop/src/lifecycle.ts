export const DESKTOP_HISTORY_INDEX = "__renrencodexDesktopHistoryIndex";

export function readDesktopHistoryIndex(state: unknown): number | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[DESKTOP_HISTORY_INDEX];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function withDesktopHistoryIndex(state: unknown, index: number): Record<string, unknown> {
  const record = state && typeof state === "object" ? state : {};
  return { ...record, [DESKTOP_HISTORY_INDEX]: index };
}

export function confirmDiscardUnsavedChanges(dirty: boolean, confirm: () => boolean): boolean {
  return !dirty || confirm();
}

export function sessionExpiryDisposition(dirty: boolean): "preserve-draft" | "logout" {
  return dirty ? "preserve-draft" : "logout";
}

export async function handleDesktopCloseRequest(options: {
  preventDefault: () => void;
  hide: () => Promise<void>;
}): Promise<void> {
  options.preventDefault();
  await options.hide();
}

export async function handleDesktopExitRequest(options: {
  dirty: boolean;
  updateBusy: boolean;
  confirm: () => boolean;
  notifyUpdateBusy: () => void;
  restore: () => Promise<void>;
  exit: () => Promise<void>;
}): Promise<void> {
  if (options.updateBusy) {
    await options.restore();
    options.notifyUpdateBusy();
    return;
  }
  if (options.dirty) {
    await options.restore();
    if (!options.confirm()) return;
  }
  await options.exit();
}
