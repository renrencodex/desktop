import { describe, expect, test } from "bun:test";

import { normalizeBrowserUrl, resolvePreviewTarget } from "./browser-url";

describe("Desktop browser URL policy", () => {
  test("allows HTTPS and loopback HTTP but rejects external HTTP", () => {
    expect(normalizeBrowserUrl("example.com/app", "http://tauri.localhost")).toEqual({
      url: "https://example.com/app",
      error: null,
    });
    expect(normalizeBrowserUrl("http://127.0.0.1:3080/app", "http://tauri.localhost")).toEqual({
      url: "http://127.0.0.1:3080/app",
      error: null,
    });
    expect(normalizeBrowserUrl("http://example.com/app", "http://tauri.localhost")).toEqual({
      url: null,
      error: "Desktop 仅允许打开 HTTPS 地址；HTTP 仅用于本机端口预览",
    });
  });

  test("maps loopback input to an authenticated preview origin", () => {
    const candidate = {
      port: 3080,
      previewUrl: "https://3080-machine.preview.renrencodex.com",
    };

    expect(resolvePreviewTarget("http://localhost:3080/app?x=1", [candidate])).toEqual({
      kind: "preview",
      candidate,
      targetUrl: "https://3080-machine.preview.renrencodex.com/app?x=1",
    });
  });
});
