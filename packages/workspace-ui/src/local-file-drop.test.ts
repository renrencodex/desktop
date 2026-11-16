import { describe, expect, test } from "bun:test";

import {
  collectLocalDropManifest,
  hasLocalFileItems,
  isFatalUploadTransportError,
  localFilesManifest,
  ConcurrentLocalUploadByteCounter,
  LocalUploadByteCounter,
} from "./local-file-drop";

function fileEntry(name: string, contents: string): FileSystemFileEntry {
  const file = new File([contents], name);
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (success: FileCallback) => success(file),
  } as FileSystemFileEntry;
}

function failingFileEntry(name: string): FileSystemFileEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (_success: FileCallback, error?: ErrorCallback) =>
      error?.(new DOMException("本地文件不可读")),
  } as FileSystemFileEntry;
}

function directoryEntry(
  name: string,
  batches: readonly (readonly FileSystemEntry[])[],
): FileSystemDirectoryEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let index = 0;
      return {
        readEntries: (success: FileSystemEntriesCallback) => success([...(batches[index++] ?? [])]),
      } as FileSystemDirectoryReader;
    },
  } as FileSystemDirectoryEntry;
}

function entryItem(entry: FileSystemEntry): DataTransferItem {
  return {
    kind: "file",
    type: "",
    getAsFile: () => null,
    webkitGetAsEntry: () => entry,
  } as DataTransferItem;
}

describe("local file drop manifest", () => {
  test("recursively enumerates every directory-reader batch and preserves empty or hidden paths", async () => {
    const empty = directoryEntry("empty", [[]]);
    const source = directoryEntry("src", [
      [fileEntry("index.ts", "export {}")],
      [fileEntry(".secret", "hidden")],
      [],
    ]);
    const root = directoryEntry("project", [[source, empty, failingFileEntry("locked")], []]);

    const manifest = await collectLocalDropManifest([entryItem(root)]);

    expect(manifest.directories).toEqual(["project", "project/empty", "project/src"]);
    expect(manifest.files.map((item) => item.relativePath)).toEqual([
      "project/src/.secret",
      "project/src/index.ts",
    ]);
    expect(await manifest.files[0]!.file.text()).toBe("hidden");
    expect(manifest.failures).toEqual([
      { relativePath: "project/locked", message: "本地文件不可读" },
    ]);
    expect(manifest.directoryEntriesSupported).toBe(true);
  });

  test("captures protected drag entries synchronously before directory traversal awaits", async () => {
    let protectedStore = false;
    const item = {
      kind: "file",
      type: "",
      getAsFile: () => null,
      webkitGetAsEntry: () => (protectedStore ? null : fileEntry("captured.txt", "ok")),
    } as DataTransferItem;

    const pending = collectLocalDropManifest([item]);
    protectedStore = true;

    expect((await pending).files.map((entry) => entry.relativePath)).toEqual(["captured.txt"]);
  });

  test("falls back to ordinary files when directory entry APIs are unavailable", async () => {
    const selected = new File(["one"], "plain.txt");
    const item = {
      kind: "file",
      type: "text/plain",
      getAsFile: () => selected,
    } as DataTransferItem;

    const manifest = await collectLocalDropManifest([item]);

    expect(manifest.files).toEqual([{ relativePath: "plain.txt", file: selected }]);
    expect(manifest.directories).toEqual([]);
    expect(manifest.directoryEntriesSupported).toBe(false);
    expect(hasLocalFileItems({ items: [item], types: [] })).toBe(true);
    expect(hasLocalFileItems({ items: [], types: ["Files"] })).toBe(true);
    expect(hasLocalFileItems({ items: [], types: ["text/plain"] })).toBe(false);
  });

  test("file picker manifests reject unsafe names without dropping valid siblings", () => {
    const valid = new File(["ok"], "ok.txt");
    const invalid = new File(["bad"], "../bad.txt");

    const manifest = localFilesManifest([invalid, valid]);

    expect(manifest.files).toEqual([{ relativePath: "ok.txt", file: valid }]);
    expect(manifest.failures).toEqual([{ relativePath: "../bad.txt", message: "文件名无效" }]);
  });
});

describe("local upload recovery", () => {
  test("stops a batch only for channel-wide failures", () => {
    for (const code of [
      "RPC_CLOSED",
      "RPC_TIMEOUT",
      "CONNECT_FAILED",
      "UNAUTHENTICATED",
      "MACHINE_OFFLINE",
      "FILE_UPLOAD_CONNECTION_LOST",
    ]) {
      expect(isFatalUploadTransportError({ code })).toBe(true);
    }
    expect(isFatalUploadTransportError({ code: "FS_FORBIDDEN" })).toBe(false);
    expect(isFatalUploadTransportError(new Error("single file failed"))).toBe(false);
  });

  test("aggregate progress remains monotonic after a partial file failure", () => {
    const counter = new LocalUploadByteCounter();
    expect(counter.beginFile()).toBe(0);
    expect(counter.recordFileProgress(900)).toBe(900);

    // The first file failed after 900 bytes. Starting its sibling retains those transferred bytes.
    expect(counter.beginFile()).toBe(900);
    expect(counter.recordFileProgress(100)).toBe(1_000);
    expect(counter.recordFileProgress(80)).toBe(1_000);
    expect(counter.recordFileProgress(500)).toBe(1_400);
    expect(counter.value).toBe(1_400);
  });

  test("concurrent aggregate progress keeps each file monotonic", () => {
    const counter = new ConcurrentLocalUploadByteCounter();
    expect(counter.recordFileProgress("first", 100)).toBe(100);
    expect(counter.recordFileProgress("second", 40)).toBe(140);
    expect(counter.recordFileProgress("first", 90)).toBe(140);
    expect(counter.recordFileProgress("second", 80)).toBe(180);
  });
});
