import { describe, expect, test } from "bun:test";

import { classifyDesktopAuthorizationCallback } from "./oauth-callback";

describe("Desktop OAuth callback disposition", () => {
  test("exchanges only the callback matching the current attempt", () => {
    expect(classifyDesktopAuthorizationCallback({ state: "current" }, { state: "current" })).toBe(
      "exchange",
    );
  });

  test("ignores old or forged state without consuming the current attempt", () => {
    const pending = { state: "current" };
    expect(classifyDesktopAuthorizationCallback(pending, { state: "old" })).toBe("ignore");
    expect(pending.state).toBe("current");
  });

  test("reports malformed callbacks only while an attempt is pending", () => {
    expect(classifyDesktopAuthorizationCallback({ state: "current" }, null)).toBe("invalid");
    expect(classifyDesktopAuthorizationCallback(null, null)).toBe("ignore");
  });
});
