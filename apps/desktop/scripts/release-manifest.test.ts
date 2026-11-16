import { describe, expect, test } from "bun:test";

import {
  assertNewerRelease,
  buildDesktopReleaseManifest,
  buildWindowsDesktopReleaseManifest,
  compareStableVersions,
  highestPublishedVersion,
  readPublishedVersion,
} from "./release-manifest";

describe("Desktop release manifest", () => {
  test("builds pinned Windows, macOS Universal, and Linux updater targets", () => {
    const manifest = buildDesktopReleaseManifest({
      version: "0.1.0",
      notes: "首个自升级版本",
      publishedAt: "2026-09-29T00:00:00.000Z",
      signatures: {
        windowsX86_64: "windows-signature",
        macosUniversal: "macos-signature",
        linuxX86_64: "linux-signature",
      },
    });
    expect(manifest.platforms["windows-x86_64"]).toEqual({
      url: "https://renrencodex.com/downloads/desktop/stable/windows-x86_64/renrencodex-desktop-0.1.0-x64.msi",
      signature: "windows-signature",
    });
    expect(manifest.platforms["darwin-aarch64"]).toEqual({
      url: "https://renrencodex.com/downloads/desktop/stable/macos-universal/renrencodex-desktop-0.1.0-universal.app.tar.gz",
      signature: "macos-signature",
    });
    expect(manifest.platforms["darwin-x86_64"]).toEqual(manifest.platforms["darwin-aarch64"]);
    expect(manifest.platforms["linux-x86_64"]).toEqual({
      url: "https://renrencodex.com/downloads/desktop/stable/linux-x86_64/renrencodex-desktop-0.1.0-x86_64.AppImage",
      signature: "linux-signature",
    });
    expect(
      buildWindowsDesktopReleaseManifest({
        version: "0.1.0",
        notes: "\uFEFF带 BOM 的更新说明",
        publishedAt: "2026-09-29T00:00:00.000Z",
        signature: "trusted-signature",
      }).notes,
    ).toBe("带 BOM 的更新说明");
  });

  test("requires stable increasing versions", () => {
    expect(compareStableVersions("0.2.0", "0.1.9")).toBe(1);
    expect(() => assertNewerRelease("0.1.0", "0.1.0")).toThrow("must be newer");
    expect(() => assertNewerRelease("0.0.9", "0.1.0")).toThrow("must be newer");
    expect(() => assertNewerRelease("0.2.0-beta.1", null)).toThrow("stable SemVer");
    const highest = highestPublishedVersion(["0.1.0", null, "0.2.0", "0.1.9"]);
    expect(highest).toBe("0.2.0");
    expect(() => assertNewerRelease("0.1.1", highest)).toThrow("must be newer");
  });

  test("rejects incomplete release data and malformed published manifests", () => {
    expect(() =>
      buildDesktopReleaseManifest({
        version: "0.1.0",
        notes: "notes",
        publishedAt: "invalid",
        signatures: {
          windowsX86_64: "windows-signature",
          macosUniversal: "macos-signature",
          linuxX86_64: "linux-signature",
        },
      }),
    ).toThrow("RFC 3339");
    expect(() =>
      buildDesktopReleaseManifest({
        version: "0.1.0",
        notes: "notes",
        publishedAt: "2026-09-29T00:00:00.000Z",
        signatures: {
          windowsX86_64: "windows-signature",
          macosUniversal: "",
          linuxX86_64: "linux-signature",
        },
      }),
    ).toThrow("macOS updater signature must not be empty");
    expect(() => readPublishedVersion({ version: 1 })).toThrow("no version");
  });
});
