import { describe, expect, test } from "bun:test";

import { createNativeThemeSync, nativeWindowTheme } from "./native-theme";

describe("nativeWindowTheme", () => {
  test("maps the selected Desktop theme to its light or dark preference", () => {
    expect(nativeWindowTheme("ink-white")).toBe("light");
    expect(nativeWindowTheme("night-moss")).toBe("dark");
    expect(nativeWindowTheme("cursor-dark")).toBe("dark");
  });
});

describe("native theme synchronization", () => {
  test("updates the native window once for each acknowledged color scheme", async () => {
    const calls: string[] = [];
    const sync = createNativeThemeSync(async (theme) => {
      calls.push(theme);
    });
    await sync("ink-white");
    await sync("ink-white");
    await sync("night-moss");
    expect(calls).toEqual(["light", "dark"]);
  });

  test("coalesces rapid choices and serializes changes behind in-flight work", async () => {
    const calls: string[] = [];
    const gate = Promise.withResolvers<void>();
    const sync = createNativeThemeSync(async (theme) => {
      calls.push(theme);
      if (calls.length === 1) await gate.promise;
    });
    const first = sync("ink-white");
    await Promise.resolve();
    const second = sync("night-moss");
    const third = sync("ink-white");
    const last = sync("cursor-dark");
    expect(calls).toEqual(["light"]);
    gate.resolve();
    await Promise.all([first, second, third, last]);
    expect(calls).toEqual(["light", "dark"]);
  });

  test("failed native sync is retryable and does not poison the queue", async () => {
    const calls: string[] = [];
    let fail = true;
    const sync = createNativeThemeSync(async (theme) => {
      calls.push(theme);
      if (fail) throw new Error("renderer stalled");
    });
    await expect(sync("night-moss")).rejects.toThrow("renderer stalled");
    fail = false;
    await sync("night-moss");
    expect(calls).toEqual(["dark", "dark"]);
  });

  test("a failed change invalidates the prior acknowledgement", async () => {
    const calls: string[] = [];
    const sync = createNativeThemeSync(async (theme) => {
      calls.push(theme);
      if (theme === "dark") throw new Error("window theme failed");
    });
    await sync("ink-white");
    await expect(sync("night-moss")).rejects.toThrow("window theme failed");
    await sync("ink-white");
    expect(calls).toEqual(["light", "dark", "light"]);
  });
});
