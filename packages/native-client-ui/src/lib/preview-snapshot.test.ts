import { describe, expect, test } from "bun:test";
import { captureAndHidePreview } from "./preview-snapshot";

function fixture() {
  const calls: string[] = [];
  const state = { overlapping: true };
  const operations = {
    shouldHide: () => state.overlapping,
    capture: async (): Promise<string | null> => {
      calls.push("capture");
      return "snapshot";
    },
    prepare: async (snapshot: string | null) => {
      calls.push("decode");
      return snapshot;
    },
    present: (snapshot: string | null) => {
      calls.push(snapshot ? "present" : "fallback");
    },
    hide: async () => {
      calls.push("hide");
    },
  };
  return { calls, state, operations };
}

describe("preview snapshot handoff", () => {
  test("layout transitions never hide without a valid decoded snapshot", async () => {
    for (const result of [null, "snapshot"]) {
      const { calls, operations } = fixture();
      operations.prepare = async () => result;
      await captureAndHidePreview(operations, undefined, { requireSnapshot: true });
      expect(calls).toEqual(result ? ["capture", "present", "hide"] : ["capture"]);
    }
  });

  for (const phase of ["capture", "prepare"] as const) {
    test(`layout ${phase} timeout releases work and ignores late completion`, async () => {
      const { calls, operations } = fixture();
      const pending = Promise.withResolvers<string | null>();
      operations[phase] = () => pending.promise;
      await captureAndHidePreview(operations, undefined, { requireSnapshot: true, timeoutMs: 10 });
      const completedCalls = [...calls];
      pending.resolve("late");
      await pending.promise;
      await Promise.resolve();
      expect(calls).toEqual(completedCalls);
      expect(calls).not.toContain("hide");
      expect(calls).not.toContain("present");
    });
  }

  for (const phase of ["capture", "prepare"] as const) {
    test(`cancelling ${phase} releases queued hide/close before the native result arrives`, async () => {
      const { calls, operations } = fixture();
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<string | null>();
      operations[phase] = () => {
        started.resolve();
        return pending.promise;
      };
      const covering = captureAndHidePreview(operations, controller.signal);
      const closing = covering.then(() => calls.push("close"));
      await started.promise;
      controller.abort();
      // The native result is deliberately still pending: close must not wait for it.
      await closing;
      expect(calls).toEqual(phase === "capture" ? ["close"] : ["capture", "close"]);
      pending.resolve("late frame");
      await pending.promise;
      await Promise.resolve();
      expect(calls).not.toContain("present");
      expect(calls).not.toContain("hide");
    });
  }

  test("an already-cancelled queued capture cannot start after the tab is reactivated", async () => {
    const { calls, operations } = fixture();
    const controller = new AbortController();
    controller.abort();
    await captureAndHidePreview(operations, controller.signal);
    expect(calls).toEqual([]);
    await captureAndHidePreview(operations, new AbortController().signal);
    expect(calls).toEqual(["capture", "decode", "present", "hide"]);
  });

  test("late native rejection is consumed after cancellation", async () => {
    const { calls, operations } = fixture();
    const controller = new AbortController();
    const pending = Promise.withResolvers<string | null>();
    operations.capture = () => pending.promise;
    const covering = captureAndHidePreview(operations, controller.signal);
    controller.abort();
    await covering;
    pending.reject(new Error("webview was closed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  test("does not hide if presenting the frame synchronously unmounts the preview", async () => {
    const { calls, operations } = fixture();
    const controller = new AbortController();
    operations.present = () => controller.abort();
    await captureAndHidePreview(operations, controller.signal);
    expect(calls).toEqual(["capture", "decode"]);
  });

  test("cancelling during hide still serializes the visibility command before close", async () => {
    const { calls, operations } = fixture();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    operations.hide = async () => {
      started.resolve();
      await pending.promise;
      calls.push("hide");
    };
    const covering = captureAndHidePreview(operations, controller.signal);
    const closing = covering.then(() => calls.push("close"));
    await started.promise;
    controller.abort();
    await Promise.resolve();
    expect(calls).not.toContain("close");
    pending.resolve();
    await closing;
    expect(calls).toEqual(["capture", "decode", "present", "hide", "close"]);
  });

  test("decodes and presents the snapshot before hiding the browser", async () => {
    const { calls, operations } = fixture();
    await captureAndHidePreview(operations);
    expect(calls).toEqual(["capture", "decode", "present", "hide"]);
  });

  test("does not capture or hide for a menu outside the preview", async () => {
    const { calls, state, operations } = fixture();
    state.overlapping = false;
    await captureAndHidePreview(operations);
    expect(calls).toEqual([]);
  });

  test("discard late captures when the menu closes or the tab/navigation changes", async () => {
    const { calls, state, operations } = fixture();
    const pending = Promise.withResolvers<string | null>();
    operations.capture = () => pending.promise;
    const hiding = captureAndHidePreview(operations);
    state.overlapping = false;
    pending.resolve("stale frame");
    await hiding;
    expect(calls).toEqual([]);
  });

  test("does not hide if the menu closes during image decoding", async () => {
    const { calls, state, operations } = fixture();
    operations.prepare = async () => {
      state.overlapping = false;
      return "stale frame";
    };
    await captureAndHidePreview(operations);
    expect(calls).toEqual(["capture"]);
  });

  test("failed or unsupported capture uses a pause notice before hiding", async () => {
    const { calls, operations } = fixture();
    operations.capture = async () => {
      throw new Error("capture unavailable");
    };
    await captureAndHidePreview(operations);
    expect(calls).toEqual(["decode", "fallback", "hide"]);
  });

  test("failed decoding also uses the pause notice", async () => {
    const { calls, operations } = fixture();
    operations.prepare = async () => {
      throw new Error("decode failed");
    };
    await captureAndHidePreview(operations);
    expect(calls).toEqual(["capture", "fallback", "hide"]);
  });
});
