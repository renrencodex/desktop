import { describe, expect, test } from "bun:test";

import {
  FILE_UPLOAD_PROTOCOL_VERSION,
  FS_UPLOAD_BINARY_HEADER_BYTES,
  FS_UPLOAD_BINARY_MAGIC,
  FS_UPLOAD_CHUNK_BYTES,
  FS_UPLOAD_CLIENT_MAX_CONCURRENT,
  FS_UPLOAD_WINDOW_BYTES,
} from "@cloud-machine/client-contracts";

import { openBinaryFileUploadSession } from "./binary-file-upload";

type Listener = (event: { data?: string | ArrayBuffer }) => void;

class FakeSocket {
  readyState = 1;
  binaryType = "blob";
  readonly textSent: Array<Record<string, unknown>> = [];
  readonly binarySent: Array<Uint8Array> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly onText: (message: Record<string, unknown>, socket: FakeSocket) => void = () => {},
    readonly onBinary: (frame: Uint8Array, socket: FakeSocket) => void = () => {},
  ) {}

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(raw: string | ArrayBuffer): void {
    if (typeof raw === "string") {
      const message = JSON.parse(raw) as Record<string, unknown>;
      this.textSent.push(message);
      this.onText(message, this);
      return;
    }
    const frame = new Uint8Array(raw.slice(0));
    this.binarySent.push(frame);
    this.onBinary(frame, this);
  }

  serverText(message: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(type: string, event: { data?: string | ArrayBuffer }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

function asWebSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket;
}

function hello(socket: FakeSocket): void {
  socket.serverText({
    type: "hello",
    protocolVersion: FILE_UPLOAD_PROTOCOL_VERSION,
    chunkBytes: FS_UPLOAD_CHUNK_BYTES,
    windowBytes: FS_UPLOAD_WINDOW_BYTES,
    maxConcurrent: FS_UPLOAD_CLIENT_MAX_CONCURRENT,
  });
}

function transferId(frame: Uint8Array): string {
  const hex = [...frame.slice(5, FS_UPLOAD_BINARY_HEADER_BYTES)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition not reached");
}

async function openSession(socket: FakeSocket) {
  const opening = openBinaryFileUploadSession({ createSocket: async () => asWebSocket(socket) });
  await Bun.sleep(0);
  hello(socket);
  return opening;
}

describe("binary file upload", () => {
  test("streams raw chunks, waits for staging, then runs the conflict check before commit", async () => {
    let openedId = "";
    let beforeCommit = false;
    const progress: number[] = [];
    const socket = new FakeSocket(
      (message, current) => {
        if (message.type === "open") {
          openedId = String(message.transferId);
          current.serverText({ type: "ready", transferId: openedId });
        } else if (message.type === "finish") {
          current.serverText({ type: "staged", transferId: openedId });
        } else if (message.type === "commit") {
          expect(beforeCommit).toBe(true);
          current.serverText({ type: "complete", transferId: openedId });
        }
      },
      (frame, current) => {
        expect(new TextDecoder().decode(frame.slice(0, 4))).toBe(FS_UPLOAD_BINARY_MAGIC);
        expect(transferId(frame)).toBe(openedId);
        current.serverText({
          type: "ack",
          transferId: openedId,
          bytes: frame.byteLength - FS_UPLOAD_BINARY_HEADER_BYTES,
        });
      },
    );
    const session = await openSession(socket);
    const result = await session.upload({
      path: "/workspace/result.bin",
      blob: new Blob([new Uint8Array([1, 2, 3])]),
      beforeCommit: () => {
        beforeCommit = true;
      },
      onProgress: (written) => progress.push(written),
    });
    expect(result).toBe(3);
    expect(progress).toEqual([0, 3, 3]);
    expect([...socket.binarySent[0]!.slice(FS_UPLOAD_BINARY_HEADER_BYTES)]).toEqual([1, 2, 3]);
    expect(socket.textSent.map((message) => message.type)).toEqual(["open", "finish", "commit"]);
    session.close();
  });

  test("uploads an empty file without sending a binary frame", async () => {
    let openedId = "";
    const socket = new FakeSocket((message, current) => {
      if (message.type === "open") {
        openedId = String(message.transferId);
        current.serverText({ type: "ready", transferId: openedId });
      } else if (message.type === "finish") {
        current.serverText({ type: "staged", transferId: openedId });
      } else if (message.type === "commit") {
        current.serverText({ type: "complete", transferId: openedId });
      }
    });
    const session = await openSession(socket);
    await expect(
      session.upload({ path: "/workspace/empty.txt", blob: new Blob([]) }),
    ).resolves.toBe(0);
    expect(socket.binarySent).toHaveLength(0);
    expect(socket.textSent.map((message) => message.type)).toEqual(["open", "finish", "commit"]);
    session.close();
  });

  test("never sends more than the negotiated credit window before acknowledgements", async () => {
    let openedId = "";
    const socket = new FakeSocket((message, current) => {
      if (message.type === "open") {
        openedId = String(message.transferId);
        current.serverText({ type: "ready", transferId: openedId });
      }
    });
    const session = await openSession(socket);
    const upload = session.upload({
      path: "/workspace/large.bin",
      blob: new Blob([new Uint8Array(FS_UPLOAD_WINDOW_BYTES + FS_UPLOAD_CHUNK_BYTES)]),
    });
    await waitFor(
      () => socket.binarySent.length === FS_UPLOAD_WINDOW_BYTES / FS_UPLOAD_CHUNK_BYTES,
    );
    expect(
      socket.binarySent.reduce(
        (total, frame) => total + frame.byteLength - FS_UPLOAD_BINARY_HEADER_BYTES,
        0,
      ),
    ).toBe(FS_UPLOAD_WINDOW_BYTES);
    socket.serverText({
      type: "ack",
      transferId: openedId,
      bytes: FS_UPLOAD_CHUNK_BYTES,
    });
    await waitFor(
      () => socket.binarySent.length === FS_UPLOAD_WINDOW_BYTES / FS_UPLOAD_CHUNK_BYTES + 1,
    );
    session.close();
    await expect(upload).rejects.toBeInstanceOf(DOMException);
  });

  test("allows three active files and isolates a per-file failure", async () => {
    const ids: string[] = [];
    const socket = new FakeSocket((message, current) => {
      if (message.type === "open") {
        const id = String(message.transferId);
        ids.push(id);
        current.serverText({ type: "ready", transferId: id });
      }
    });
    const session = await openSession(socket);
    const active = [0, 1, 2].map((index) =>
      session.upload({ path: `/workspace/${index}`, blob: new Blob([new Uint8Array([index])]) }),
    );
    await waitFor(() => ids.length === 3);
    await expect(
      session.upload({ path: "/workspace/fourth", blob: new Blob([new Uint8Array([4])]) }),
    ).rejects.toMatchObject({ code: "FILE_UPLOAD_LIMIT_REACHED" });

    socket.serverText({
      type: "fileError",
      transferId: ids[0],
      code: "FS_FORBIDDEN",
      message: "denied",
    });
    await expect(active[0]).rejects.toMatchObject({ code: "FS_FORBIDDEN" });
    expect(socket.readyState).toBe(1);
    session.close();
    await Promise.allSettled(active.slice(1));
  });

  test("reuses three slots to upload a ten-file batch over one session", async () => {
    let active = 0;
    let maxActive = 0;
    let opened = 0;
    const socket = new FakeSocket(
      (message, current) => {
        const id = String(message.transferId);
        if (message.type === "open") {
          opened++;
          active++;
          maxActive = Math.max(maxActive, active);
          current.serverText({ type: "ready", transferId: id });
        } else if (message.type === "finish") {
          current.serverText({ type: "staged", transferId: id });
        } else if (message.type === "commit") {
          active--;
          current.serverText({ type: "complete", transferId: id });
        }
      },
      (frame, current) =>
        current.serverText({
          type: "ack",
          transferId: transferId(frame),
          bytes: frame.byteLength - FS_UPLOAD_BINARY_HEADER_BYTES,
        }),
    );
    const session = await openSession(socket);
    let nextFile = 0;
    const worker = async () => {
      for (;;) {
        const index = nextFile++;
        if (index >= 10) return;
        await session.upload({
          path: `/workspace/file-${index}.bin`,
          blob: new Blob([new Uint8Array([index])]),
        });
      }
    };
    await Promise.all(Array.from({ length: FS_UPLOAD_CLIENT_MAX_CONCURRENT }, () => worker()));
    expect(opened).toBe(10);
    expect(maxActive).toBe(FS_UPLOAD_CLIENT_MAX_CONCURRENT);
    expect(active).toBe(0);
    session.close();
  });

  test("cancels a staged file when the pre-commit conflict check fails", async () => {
    let id = "";
    const socket = new FakeSocket(
      (message, current) => {
        if (message.type === "open") {
          id = String(message.transferId);
          current.serverText({ type: "ready", transferId: id });
        } else if (message.type === "finish") {
          current.serverText({ type: "staged", transferId: id });
        }
      },
      (frame, current) =>
        current.serverText({
          type: "ack",
          transferId: id,
          bytes: frame.byteLength - FS_UPLOAD_BINARY_HEADER_BYTES,
        }),
    );
    const session = await openSession(socket);
    await expect(
      session.upload({
        path: "/workspace/conflict.txt",
        blob: new Blob(["new"]),
        beforeCommit: () => {
          throw new Error("editor changed");
        },
      }),
    ).rejects.toThrow("editor changed");
    expect(socket.textSent.at(-1)).toMatchObject({ type: "cancel", transferId: id });
    session.close();
  });
});
