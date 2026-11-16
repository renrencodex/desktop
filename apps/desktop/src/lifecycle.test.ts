import { describe, expect, mock, test } from "bun:test";

import {
  DESKTOP_HISTORY_INDEX,
  confirmDiscardUnsavedChanges,
  handleDesktopCloseRequest,
  handleDesktopExitRequest,
  readDesktopHistoryIndex,
  sessionExpiryDisposition,
  withDesktopHistoryIndex,
} from "./lifecycle";

describe("Desktop unsaved-content lifecycle", () => {
  test("preserves history state while tagging local navigation", () => {
    expect(withDesktopHistoryIndex({ existing: true }, 2)).toEqual({
      existing: true,
      [DESKTOP_HISTORY_INDEX]: 2,
    });
    expect(readDesktopHistoryIndex({ [DESKTOP_HISTORY_INDEX]: 2 })).toBe(2);
    expect(readDesktopHistoryIndex({ [DESKTOP_HISTORY_INDEX]: "2" })).toBeNull();
  });

  test("asks only when unsaved content would be discarded", () => {
    const confirm = mock(() => false);
    expect(confirmDiscardUnsavedChanges(false, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(confirmDiscardUnsavedChanges(true, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("keeps a dirty editor mounted when the remote session expires", () => {
    expect(sessionExpiryDisposition(true)).toBe("preserve-draft");
    expect(sessionExpiryDisposition(false)).toBe("logout");
  });

  test("always intercepts native close and hides without discarding content", async () => {
    const preventDefault = mock(() => undefined);
    const hide = mock(async () => undefined);
    await handleDesktopCloseRequest({
      preventDefault,
      hide,
    });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  test("exits directly when clean and only after confirmation when dirty", async () => {
    const exit = mock(async () => undefined);
    const restore = mock(async () => undefined);
    const confirm = mock(() => false);
    const notifyUpdateBusy = mock(() => undefined);
    await handleDesktopExitRequest({
      dirty: false,
      updateBusy: false,
      confirm,
      notifyUpdateBusy,
      restore,
      exit,
    });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    await handleDesktopExitRequest({
      dirty: true,
      updateBusy: false,
      confirm,
      notifyUpdateBusy,
      restore,
      exit,
    });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);

    confirm.mockImplementation(() => true);
    await handleDesktopExitRequest({
      dirty: true,
      updateBusy: false,
      confirm,
      notifyUpdateBusy,
      restore,
      exit,
    });
    expect(restore).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledTimes(2);
  });

  test("blocks exit and notifies while an update is being installed", async () => {
    const exit = mock(async () => undefined);
    const restore = mock(async () => undefined);
    const confirm = mock(() => true);
    const notifyUpdateBusy = mock(() => undefined);
    await handleDesktopExitRequest({
      dirty: false,
      updateBusy: true,
      confirm,
      notifyUpdateBusy,
      restore,
      exit,
    });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(notifyUpdateBusy).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
