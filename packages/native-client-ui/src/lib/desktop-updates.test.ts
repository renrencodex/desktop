import { describe, expect, test } from "bun:test";

import {
  INITIAL_DESKTOP_UPDATE_DOWNLOAD,
  PREPARING_DESKTOP_UPDATE_DOWNLOAD,
  applyDesktopUpdateProgress,
  desktopUpdateProgressPercent,
  formatDesktopUpdateBytes,
} from "./desktop-updates";

describe("Desktop update progress", () => {
  test("starts at zero while waiting for the first download event", () => {
    expect(PREPARING_DESKTOP_UPDATE_DOWNLOAD).toEqual({
      downloadedBytes: 0,
      totalBytes: null,
      stage: "preparing",
    });
    expect(desktopUpdateProgressPercent(PREPARING_DESKTOP_UPDATE_DOWNLOAD)).toBe(0);
  });

  test("accumulates chunks and calculates bounded percentages", () => {
    const started = applyDesktopUpdateProgress(INITIAL_DESKTOP_UPDATE_DOWNLOAD, {
      event: "started",
      data: { contentLength: 100 },
    });
    expect(desktopUpdateProgressPercent(started)).toBe(0);
    const downloading = applyDesktopUpdateProgress(started, {
      event: "progress",
      data: { chunkLength: 30 },
    });
    expect(downloading).toEqual({ downloadedBytes: 30, totalBytes: 100, stage: "downloading" });
    expect(desktopUpdateProgressPercent(downloading)).toBe(30);
    expect(desktopUpdateProgressPercent({ ...downloading, downloadedBytes: 120 })).toBe(100);
  });

  test("uses indeterminate progress when content length is missing", () => {
    const started = applyDesktopUpdateProgress(INITIAL_DESKTOP_UPDATE_DOWNLOAD, {
      event: "started",
      data: { contentLength: null },
    });
    expect(desktopUpdateProgressPercent(started)).toBeNull();
    expect(formatDesktopUpdateBytes(10 * 1024 * 1024)).toBe("10.0 MB");
  });

  test("moves to installing after the verified download finishes", () => {
    const downloaded = applyDesktopUpdateProgress(INITIAL_DESKTOP_UPDATE_DOWNLOAD, {
      event: "downloaded",
    });
    const installing = applyDesktopUpdateProgress(INITIAL_DESKTOP_UPDATE_DOWNLOAD, {
      event: "installing",
    });
    expect(downloaded.stage).toBe("installing");
    expect(desktopUpdateProgressPercent(downloaded)).toBe(100);
    expect(installing.stage).toBe("installing");
    expect(desktopUpdateProgressPercent(installing)).toBe(100);
  });
});
