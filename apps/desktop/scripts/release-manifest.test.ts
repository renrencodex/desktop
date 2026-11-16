import { describe, expect, test } from "bun:test";

import {
  assertNewerRelease,
  buildDesktopReleaseManifest,
  compareStableVersions,
  highestPublishedVersion,
  readPublishedVersion,
} from "./release-manifest";

describe("Desktop release manifest", () => {
  test("builds the single supported Windows target with an inline signature", () => {
    const manifest = buildDesktopReleaseManifest({
      version: "0.1.0",
      notes: "首个自升级版本",
      publishedAt: "2026-09-29T00:00:00.000Z",
      signature: "trusted-signature",
    });
    expect(manifest.platforms["windows-x86_64"]).toEqual({
      url: "https://renrencodex.com/downloads/desktop/stable/windows-x86_64/renrencodex-desktop-0.1.0-x64.msi",
      signature: "trusted-signature",
    });
    expect(
      buildDesktopReleaseManifest({
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
        signature: "signature",
      }),
    ).toThrow("RFC 3339");
    expect(() =>
      buildDesktopReleaseManifest({
        version: "0.1.0",
        notes: "notes",
        publishedAt: "2026-09-29T00:00:00.000Z",
        signature: "",
      }),
    ).toThrow("must not be empty");
    expect(() => readPublishedVersion({ version: 1 })).toThrow("no version");
  });
});
