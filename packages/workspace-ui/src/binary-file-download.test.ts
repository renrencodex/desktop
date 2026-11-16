import { describe, expect, test } from "bun:test";

import {
  createBrowserDownloadSink,
  downloadBinaryFile,
  FILE_DOWNLOAD_MEMORY_FALLBACK_MAX_BYTES,
  FileDownloadStalledError,
  receiveBinaryFileDownload,
  type BinaryDownloadSink,
  type DownloadArtifact,
} from "./binary-file-download";

type Listener = (event: { data?: string | ArrayBuffer }) => void;
const FILE_IDENTITY = "a".repeat(64);

class FakeSocket {
  readyState = 0;
  binaryType = "blob";
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly onSend: (message: Record<string, unknown>, socket: FakeSocket) => void) {}

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(message);
    this.onSend(message, this);
  }

  serverText(message: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  serverBinary(bytes: Uint8Array): void {
    const copy = bytes.slice();
    this.emit("message", { data: copy.buffer });
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit("close", {});
  }

  fail(): void {
    this.emit("error", {});
    this.close();
  }

  private emit(type: string, event: { data?: string | ArrayBuffer }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

class TestSink implements BinaryDownloadSink {
  protected bytes: number[] = [];
  discarded = false;

  get position(): number {
    return this.bytes.length;
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.bytes.push(...chunk);
  }

  async complete(): Promise<DownloadArtifact> {
    const blob = new Blob([new Uint8Array(this.bytes)]);
    return { blob, size: this.bytes.length, dispose: async () => {} };
  }

  async discard(): Promise<void> {
    this.discarded = true;
    this.bytes = [];
  }
}

class ResettableTestSink extends TestSink {
  resets = 0;

  async reset(): Promise<void> {
    this.resets += 1;
    this.bytes = [];
  }
}

function asWebSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition not reached");
}

describe("binary file download", () => {
  test("releases a streamed native artifact without publishing a browser download", async () => {
    let position = 0;
    let disposed = 0;
    const sink: BinaryDownloadSink = {
      get position() {
        return position;
      },
      async write(chunk) {
        position += chunk.byteLength;
      },
      async complete() {
        return {
          blob: new Blob(),
          size: position,
          dispose: async () => {
            disposed += 1;
          },
        };
      },
      async discard() {},
    };
    const socket = new FakeSocket((message, current) => {
      if (message.type === "open") {
        current.serverText({
          type: "ready",
          size: 3,
          mtime: 1,
          identity: FILE_IDENTITY,
          offset: 0,
        });
      } else if (message.type === "start") {
        current.serverBinary(new Uint8Array([1, 2, 3]));
      } else if (message.type === "ack") {
        current.serverText({ type: "complete" });
      }
    });

    await expect(
      downloadBinaryFile({
        path: "/workspace/native.bin",
        fileName: "native.bin",
        saveArtifact: false,
        createSink: async () => sink,
        createSocket: async () => {
          queueMicrotask(() => socket.open());
          return asWebSocket(socket);
        },
      }),
    ).resolves.toBe(3);
    expect(disposed).toBe(1);
  });

  test("falls back to bounded memory when an exposed OPFS implementation cannot create storage", async () => {
    const originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: {
        storage: {
          getDirectory: async () => {
            throw new DOMException("OPFS unavailable", "SecurityError");
          },
        },
      },
    });
    try {
      const sink = await createBrowserDownloadSink(3);
      await sink.write(new Uint8Array([1, 2, 3]));
      const artifact = await sink.complete();
      expect([...new Uint8Array(await artifact.blob.arrayBuffer())]).toEqual([1, 2, 3]);
      await expect(
        createBrowserDownloadSink(FILE_DOWNLOAD_MEMORY_FALLBACK_MAX_BYTES + 1),
      ).rejects.toMatchObject({ code: "FILE_DOWNLOAD_LOCAL_LIMIT" });
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        writable: true,
        value: originalNavigator,
      });
    }
  });

  test("reclaims stale OPFS download entries before creating a new sink", async () => {
    const originalNavigator = globalThis.navigator;
    const staleName = ".renrencodex-download-v1-stale.tmp";
    const unrelatedName = "keep-me.tmp";
    const removed: string[] = [];
    const entries = new Map<string, FileSystemFileHandle>();
    const staleHandle = {
      kind: "file",
      name: staleName,
      getFile: async () => new File([], staleName, { lastModified: 0 }),
    } as unknown as FileSystemFileHandle;
    const unrelatedHandle = {
      kind: "file",
      name: unrelatedName,
      getFile: async () => new File([], unrelatedName, { lastModified: 0 }),
    } as unknown as FileSystemFileHandle;
    entries.set(staleName, staleHandle);
    entries.set(unrelatedName, unrelatedHandle);
    const root = {
      kind: "directory",
      name: "root",
      async *entries() {
        yield* entries.entries();
      },
      async getFileHandle(name: string) {
        const handle = {
          kind: "file",
          name,
          async createWritable() {
            return {
              write: async () => {},
              close: async () => {},
              abort: async () => {},
            } as unknown as FileSystemWritableFileStream;
          },
          getFile: async () => new File([], name),
        } as unknown as FileSystemFileHandle;
        entries.set(name, handle);
        return handle;
      },
      async removeEntry(name: string) {
        removed.push(name);
        entries.delete(name);
      },
    } as unknown as FileSystemDirectoryHandle;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: { storage: { getDirectory: async () => root } },
    });
    try {
      const sink = await createBrowserDownloadSink(1);
      expect(removed).toContain(staleName);
      expect(removed).not.toContain(unrelatedName);
      expect(removed.filter((name) => name.startsWith(".renrencodex-download-v1-"))).toHaveLength(
        1,
      );
      await sink.discard();
      expect(removed.filter((name) => name.startsWith(".renrencodex-download-v1-"))).toHaveLength(
        2,
      );
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        writable: true,
        value: originalNavigator,
      });
    }
  });

  test("writes raw frames in order and acknowledges only after the sink write", async () => {
    const sink = new TestSink();
    const progress: number[] = [];
    let acknowledgements = 0;
    const socket = new FakeSocket((message, current) => {
      if (message.type === "open") {
        current.serverText({
          type: "ready",
          size: 6,
          mtime: 10,
          identity: FILE_IDENTITY,
          offset: 0,
        });
      } else if (message.type === "start") {
        current.serverBinary(new Uint8Array([1, 2, 3]));
        current.serverBinary(new Uint8Array([4, 5, 6]));
      } else if (message.type === "ack") {
        acknowledgements += Number(message.bytes);
        if (acknowledgements === 6) current.serverText({ type: "complete" });
      }
    });

    const result = receiveBinaryFileDownload({
      path: "/workspace/data.bin",
      createSocket: async () => {
        queueMicrotask(() => socket.open());
        return asWebSocket(socket);
      },
      createSink: async () => sink,
      onProgress: (received) => progress.push(received),
    });

    const artifact = await result;
    expect(acknowledgements).toBe(6);
    expect(progress).toEqual([0, 3, 6]);
    expect([...new Uint8Array(await artifact.blob.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("reconnects from the disk-confirmed offset with the original identity", async () => {
    const sink = new TestSink();
    const opens: Array<Record<string, unknown>> = [];
    let attempt = 0;
    let retries = 0;
    const createSocket = async () => {
      attempt += 1;
      const currentAttempt = attempt;
      const socket = new FakeSocket((message, current) => {
        if (message.type === "open") {
          opens.push(message);
          current.serverText({
            type: "ready",
            size: 6,
            mtime: 10,
            identity: FILE_IDENTITY,
            offset: message.offset,
          });
        } else if (message.type === "start") {
          current.serverBinary(
            currentAttempt === 1 ? new Uint8Array([1, 2, 3]) : new Uint8Array([4, 5, 6]),
          );
        } else if (message.type === "ack") {
          if (currentAttempt === 1) current.close();
          else current.serverText({ type: "complete" });
        }
      });
      queueMicrotask(() => socket.open());
      return asWebSocket(socket);
    };

    const artifact = await receiveBinaryFileDownload({
      path: "/workspace/data.bin",
      createSocket,
      createSink: async () => sink,
      onRetry: () => {
        retries += 1;
      },
    });

    expect(retries).toBe(1);
    expect(opens).toEqual([
      {
        type: "open",
        path: "/workspace/data.bin",
        offset: 0,
      },
      {
        type: "open",
        path: "/workspace/data.bin",
        offset: 3,
        expectedSize: 6,
        expectedMtime: 10,
        expectedIdentity: FILE_IDENTITY,
      },
    ]);
    expect([...new Uint8Array(await artifact.blob.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("restarts a directory ZIP from zero after a transient disconnect", async () => {
    const sinks: TestSink[] = [];
    const opens: Array<Record<string, unknown>> = [];
    const progress: Array<{ processedEntries: number; sourceBytes: number }> = [];
    let attempt = 0;
    const artifact = await receiveBinaryFileDownload({
      kind: "directory",
      path: "/workspace/project",
      createSink: async (size) => {
        expect(size).toBeNull();
        const sink = new TestSink();
        sinks.push(sink);
        return sink;
      },
      createSocket: async () => {
        attempt += 1;
        const currentAttempt = attempt;
        const socket = new FakeSocket((message, current) => {
          if (message.type === "open") {
            opens.push(message);
            current.serverText({
              type: "ready",
              kind: "directory",
              archiveFormat: "zip",
              offset: 0,
            });
          } else if (message.type === "start") {
            current.serverText({
              type: "progress",
              processedEntries: currentAttempt,
              sourceBytes: currentAttempt * 10,
              skippedEntries: 0,
            });
            current.serverBinary(
              currentAttempt === 1 ? new Uint8Array([1, 2]) : new Uint8Array([3, 4, 5]),
            );
          } else if (message.type === "ack" && currentAttempt === 1) {
            current.close();
          } else if (message.type === "ack") {
            current.serverText({
              type: "complete",
              kind: "directory",
              size: 3,
              processedEntries: 2,
              sourceBytes: 20,
              skippedEntries: 0,
            });
          }
        });
        queueMicrotask(() => socket.open());
        return asWebSocket(socket);
      },
      onArchiveProgress: (value) =>
        progress.push({
          processedEntries: value.processedEntries,
          sourceBytes: value.sourceBytes,
        }),
    });

    expect(attempt).toBe(2);
    expect(sinks).toHaveLength(2);
    expect(sinks[0]!.discarded).toBe(true);
    expect(opens).toEqual([
      {
        type: "open",
        kind: "directory",
        archiveFormat: "zip",
        path: "/workspace/project",
      },
      {
        type: "open",
        kind: "directory",
        archiveFormat: "zip",
        path: "/workspace/project",
      },
    ]);
    expect([...new Uint8Array(await artifact.blob.arrayBuffer())]).toEqual([3, 4, 5]);
    expect(artifact.archive).toEqual({
      size: 3,
      processedEntries: 2,
      sourceBytes: 20,
      skippedEntries: 0,
    });
    expect(progress.at(-1)).toEqual({ processedEntries: 2, sourceBytes: 20 });
  });

  test("restarts a directory ZIP by resetting a reusable native sink", async () => {
    const sink = new ResettableTestSink();
    let sinkCreations = 0;
    let attempt = 0;
    const artifact = await receiveBinaryFileDownload({
      kind: "directory",
      path: "/workspace/project",
      createSink: async () => {
        sinkCreations += 1;
        return sink;
      },
      createSocket: async () => {
        attempt += 1;
        const currentAttempt = attempt;
        const socket = new FakeSocket((message, current) => {
          if (message.type === "open") {
            current.serverText({
              type: "ready",
              kind: "directory",
              archiveFormat: "zip",
              offset: 0,
            });
          } else if (message.type === "start") {
            current.serverBinary(
              currentAttempt === 1 ? new Uint8Array([1, 2]) : new Uint8Array([3, 4, 5]),
            );
          } else if (message.type === "ack" && currentAttempt === 1) {
            current.close();
          } else if (message.type === "ack") {
            current.serverText({
              type: "complete",
              kind: "directory",
              size: 3,
              processedEntries: 1,
              sourceBytes: 3,
              skippedEntries: 0,
            });
          }
        });
        queueMicrotask(() => socket.open());
        return asWebSocket(socket);
      },
    });

    expect(attempt).toBe(2);
    expect(sinkCreations).toBe(1);
    expect(sink.resets).toBe(1);
    expect(sink.discarded).toBe(false);
    expect([...new Uint8Array(await artifact.blob.arrayBuffer())]).toEqual([3, 4, 5]);
  });

  test("rejects directory completion metadata that regresses progress", async () => {
    const result = receiveBinaryFileDownload({
      kind: "directory",
      path: "/workspace/project",
      createSink: async () => new TestSink(),
      createSocket: async () => {
        const socket = new FakeSocket((message, current) => {
          if (message.type === "open") {
            current.serverText({
              type: "ready",
              kind: "directory",
              archiveFormat: "zip",
              offset: 0,
            });
          } else if (message.type === "start") {
            current.serverText({
              type: "progress",
              processedEntries: 3,
              sourceBytes: 10,
              skippedEntries: 1,
            });
            current.serverText({
              type: "complete",
              kind: "directory",
              size: 0,
              processedEntries: 2,
              sourceBytes: 10,
              skippedEntries: 1,
            });
          }
        });
        queueMicrotask(() => socket.open());
        return asWebSocket(socket);
      },
    });

    await expect(result).rejects.toMatchObject({ code: "FILE_DOWNLOAD_INVALID" });
  });

  test("drops queued frames from a failed socket before retrying the shared sink", async () => {
    let position = 0;
    const bytes: number[] = [];
    let writes = 0;
    let releaseFirstWrite!: () => void;
    let markFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const sink: BinaryDownloadSink = {
      get position() {
        return position;
      },
      async write(chunk) {
        writes += 1;
        if (writes === 1) {
          markFirstWriteStarted();
          await firstWriteGate;
        }
        bytes.push(...chunk);
        position += chunk.byteLength;
      },
      async complete() {
        return {
          blob: new Blob([new Uint8Array(bytes)]),
          size: position,
          dispose: async () => {},
        };
      },
      async discard() {
        bytes.length = 0;
        position = 0;
      },
    };
    let attempt = 0;
    const offsets: number[] = [];
    const result = receiveBinaryFileDownload({
      path: "/workspace/queued.bin",
      createSink: async () => sink,
      createSocket: async () => {
        attempt += 1;
        const currentAttempt = attempt;
        let offset = 0;
        const socket = new FakeSocket((message, current) => {
          if (message.type === "open") {
            offset = Number(message.offset ?? 0);
            offsets.push(offset);
            current.serverText({
              type: "ready",
              size: 9,
              mtime: 10,
              identity: FILE_IDENTITY,
              offset,
            });
          } else if (message.type === "start" && currentAttempt === 1) {
            current.serverBinary(new Uint8Array([1, 2, 3]));
            current.serverBinary(new Uint8Array([4, 5, 6]));
            current.close();
          } else if (message.type === "start") {
            expect(offset).toBe(3);
            current.serverBinary(new Uint8Array([4, 5, 6, 7, 8, 9]));
          } else if (message.type === "ack" && currentAttempt === 2) {
            current.serverText({ type: "complete" });
          }
        });
        queueMicrotask(() => socket.open());
        return asWebSocket(socket);
      },
    });

    await firstWriteStarted;
    releaseFirstWrite();
    const artifact = await result;
    expect(offsets).toEqual([0, 3]);
    expect(writes).toBe(2);
    expect([...new Uint8Array(await artifact.blob.arrayBuffer())]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  test("uses a sliding no-data deadline and discards partial output", async () => {
    const sink = new TestSink();
    const socket = new FakeSocket((message, current) => {
      if (message.type === "open") {
        current.serverText({
          type: "ready",
          size: 10,
          mtime: 10,
          identity: FILE_IDENTITY,
          offset: 0,
        });
      }
    });
    const result = receiveBinaryFileDownload({
      path: "/workspace/stalled.bin",
      createSocket: async () => {
        queueMicrotask(() => socket.open());
        return asWebSocket(socket);
      },
      createSink: async () => sink,
      idleTimeoutMs: 10,
      maxTransientRetries: 0,
    });

    await expect(result).rejects.toBeInstanceOf(FileDownloadStalledError);
    expect(sink.discarded).toBe(true);
  });

  test("cancels only the download socket and discards its partial sink", async () => {
    const sink = new TestSink();
    const controller = new AbortController();
    let cancelled = false;
    const socket = new FakeSocket((message, current) => {
      if (message.type === "open")
        current.serverText({
          type: "ready",
          size: 10,
          mtime: 10,
          identity: FILE_IDENTITY,
          offset: 0,
        });
      if (message.type === "cancel") cancelled = true;
    });
    const result = receiveBinaryFileDownload({
      path: "/workspace/cancel.bin",
      createSocket: async () => {
        queueMicrotask(() => socket.open());
        return asWebSocket(socket);
      },
      createSink: async () => sink,
      signal: controller.signal,
    });
    await waitFor(() => socket.sent.some((message) => message.type === "start"));
    controller.abort(new DOMException("user cancelled", "AbortError"));

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(sink.discarded).toBe(true);
  });

  test("forwards cancellation while socket creation is pending", async () => {
    const controller = new AbortController();
    let releaseSocketCreation!: () => void;
    let markSocketCreationStarted!: () => void;
    const socketCreationStarted = new Promise<void>((resolve) => {
      markSocketCreationStarted = resolve;
    });
    const socketCreationGate = new Promise<void>((resolve) => {
      releaseSocketCreation = resolve;
    });
    let socketsCreated = 0;
    const result = receiveBinaryFileDownload({
      path: "/workspace/cancel-before-connect.bin",
      signal: controller.signal,
      createSocket: async (signal) => {
        expect(signal).toBe(controller.signal);
        markSocketCreationStarted();
        await socketCreationGate;
        signal?.throwIfAborted();
        socketsCreated += 1;
        return asWebSocket(new FakeSocket(() => {}));
      },
    });
    await socketCreationStarted;

    controller.abort(new DOMException("workspace inactive", "AbortError"));
    releaseSocketCreation();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(socketsCreated).toBe(0);
  });

  test("does not publish an artifact when cancellation races with local finalization", async () => {
    const controller = new AbortController();
    let position = 0;
    let releaseComplete!: () => void;
    let markCompleteStarted!: () => void;
    let disposed = 0;
    let discarded = 0;
    const completeStarted = new Promise<void>((resolve) => {
      markCompleteStarted = resolve;
    });
    const completeGate = new Promise<void>((resolve) => {
      releaseComplete = resolve;
    });
    const sink: BinaryDownloadSink = {
      get position() {
        return position;
      },
      async write(chunk) {
        position += chunk.byteLength;
      },
      async complete() {
        markCompleteStarted();
        await completeGate;
        return {
          blob: new Blob([new Uint8Array(position)]),
          size: position,
          dispose: async () => {
            disposed += 1;
          },
        };
      },
      async discard() {
        discarded += 1;
      },
    };
    const socket = new FakeSocket((message, current) => {
      if (message.type === "open")
        current.serverText({
          type: "ready",
          size: 1,
          mtime: 1,
          identity: FILE_IDENTITY,
          offset: 0,
        });
      else if (message.type === "start") current.serverBinary(new Uint8Array([1]));
      else if (message.type === "ack") current.serverText({ type: "complete" });
    });
    const result = receiveBinaryFileDownload({
      path: "/workspace/finalizing.bin",
      createSocket: async () => {
        queueMicrotask(() => socket.open());
        return asWebSocket(socket);
      },
      createSink: async () => sink,
      signal: controller.signal,
    });
    await completeStarted;
    controller.abort(new DOMException("workspace inactive", "AbortError"));
    releaseComplete();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(disposed).toBe(1);
    expect(discarded).toBe(1);
  });

  test("rejects resume when the remote file identity changes", async () => {
    const sink = new TestSink();
    let attempt = 0;
    const result = receiveBinaryFileDownload({
      path: "/workspace/changing.bin",
      createSink: async () => sink,
      createSocket: async () => {
        attempt += 1;
        const currentAttempt = attempt;
        const socket = new FakeSocket((message, current) => {
          if (message.type === "open") {
            current.serverText({
              type: "ready",
              size: 6,
              mtime: 10,
              identity: currentAttempt === 1 ? FILE_IDENTITY : "b".repeat(64),
              offset: message.offset,
            });
          } else if (message.type === "start" && currentAttempt === 1) {
            current.serverBinary(new Uint8Array([1, 2, 3]));
          } else if (message.type === "ack" && currentAttempt === 1) {
            current.close();
          }
        });
        queueMicrotask(() => socket.open());
        return asWebSocket(socket);
      },
    });

    await expect(result).rejects.toMatchObject({ code: "FILE_DOWNLOAD_CHANGED" });
    expect(attempt).toBe(2);
    expect(sink.discarded).toBe(true);
  });
});
