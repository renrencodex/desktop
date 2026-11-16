import { describe, expect, test } from "bun:test";

import { createReleaseTauriConfig, readReleaseSigningEnvironment } from "./build-windows-release";

describe("Desktop Windows release build", () => {
  test("creates the complete Tauri updater configuration from the public key", () => {
    expect(createReleaseTauriConfig("  updater-public-key\n")).toEqual({
      bundle: {
        createUpdaterArtifacts: true,
      },
      plugins: {
        updater: {
          pubkey: "updater-public-key",
        },
      },
    });
  });

  test("requires both signing key inputs before invoking Tauri", () => {
    expect(() => readReleaseSigningEnvironment({})).toThrow("TAURI_SIGNING_PRIVATE_KEY");
    expect(() =>
      readReleaseSigningEnvironment({ TAURI_SIGNING_PRIVATE_KEY: "private-key" }),
    ).toThrow("RENRENCODEX_UPDATER_PUBLIC_KEY");
    expect(
      readReleaseSigningEnvironment({
        TAURI_SIGNING_PRIVATE_KEY: "private-key",
        RENRENCODEX_UPDATER_PUBLIC_KEY: " public-key ",
      }),
    ).toEqual({ publicKey: "public-key" });
  });
});
