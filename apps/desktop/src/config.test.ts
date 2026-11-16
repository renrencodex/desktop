import { describe, expect, test } from "bun:test";

import { resolveDesktopBuildConfig } from "./config";

describe("Desktop build endpoints", () => {
  test("accepts secure production API and Gateway endpoints", () => {
    expect(
      resolveDesktopBuildConfig(
        {
          VITE_API_BASE_URL: "https://renrencodex.com/",
          VITE_WEB_BASE_URL: "https://renrencodex.com/",
          VITE_GATEWAY_WS_URL: "wss://renrencodex.com/gateway/",
        },
        true,
      ),
    ).toEqual({
      apiBaseUrl: "https://renrencodex.com",
      gatewayWsUrl: "wss://renrencodex.com/gateway",
      webBaseUrl: "https://renrencodex.com",
    });
  });

  test("only permits insecure URLs for loopback development", () => {
    expect(
      resolveDesktopBuildConfig(
        {
          VITE_API_BASE_URL: "http://localhost:3000",
          VITE_WEB_BASE_URL: "http://localhost:5173",
          VITE_GATEWAY_WS_URL: "ws://localhost:7444",
        },
        false,
      ),
    ).toEqual({
      apiBaseUrl: "http://localhost:3000",
      webBaseUrl: "http://localhost:5173",
      gatewayWsUrl: "ws://localhost:7444",
    });
    expect(() =>
      resolveDesktopBuildConfig(
        {
          VITE_API_BASE_URL: "http://cloud.example",
          VITE_WEB_BASE_URL: "http://cloud.example",
          VITE_GATEWAY_WS_URL: "ws://cloud.example/gateway",
        },
        false,
      ),
    ).toThrow("HTTPS/WSS");
    expect(() =>
      resolveDesktopBuildConfig(
        {
          VITE_API_BASE_URL: "http://localhost:3000",
          VITE_WEB_BASE_URL: "http://localhost:5173",
          VITE_GATEWAY_WS_URL: "ws://localhost:7444",
        },
        true,
      ),
    ).toThrow("HTTPS/WSS");
    const production = {
      VITE_API_BASE_URL: "https://renrencodex.com",
      VITE_WEB_BASE_URL: "https://renrencodex.com",
      VITE_GATEWAY_WS_URL: "wss://renrencodex.com/gateway",
    };
    for (const override of [
      { VITE_API_BASE_URL: "https://lookalike.example" },
      { VITE_WEB_BASE_URL: "https://lookalike.example" },
      { VITE_GATEWAY_WS_URL: "wss://lookalike.example/gateway" },
    ]) {
      expect(() => resolveDesktopBuildConfig({ ...production, ...override }, true)).toThrow(
        "受信任",
      );
    }
  });

  test("requires an independent Web endpoint and only permits the exact local development trio", () => {
    expect(() =>
      resolveDesktopBuildConfig(
        {
          VITE_API_BASE_URL: "https://renrencodex.com",
          VITE_GATEWAY_WS_URL: "wss://renrencodex.com/gateway",
        },
        true,
      ),
    ).toThrow("VITE_WEB_BASE_URL");
    expect(() =>
      resolveDesktopBuildConfig(
        {
          VITE_API_BASE_URL: "http://localhost:3000",
          VITE_WEB_BASE_URL: "http://localhost:5174",
          VITE_GATEWAY_WS_URL: "ws://localhost:7444",
        },
        false,
      ),
    ).toThrow("HTTPS/WSS");
  });
});
