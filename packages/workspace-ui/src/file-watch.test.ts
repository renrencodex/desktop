import { describe, expect, test } from "bun:test";

import { watchMachineFileOnce } from "./file-watch";

type Listener = (event: { data?: string }) => void;

class FakeSocket {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open", {});
  }

  serverMessage(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  close(): void {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", {});
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
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

describe("file watch client", () => {
  test("reconciles on ready and turns sequence gaps into a full resync", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const invalidations: Array<{ sequence: number | null; resync: boolean }> = [];
    const watching = watchMachineFileOnce({
      machineId: "machine-1",
      path: "/workspace/readme.md",
      signal: controller.signal,
      createSocket: async () => asWebSocket(socket),
      onInvalidate: (event) => invalidations.push(event),
    });
    await Bun.sleep(0);
    socket.open();
    expect(socket.sent).toEqual([{ type: "watch", path: "/workspace/readme.md" }]);

    socket.serverMessage({ type: "ready" });
    socket.serverMessage({ type: "changed", sequence: 1, resync: false });
    socket.serverMessage({ type: "changed", sequence: 1, resync: false });
    socket.serverMessage({ type: "changed", sequence: 3, resync: false });
    expect(invalidations).toEqual([
      { sequence: null, resync: true },
      { sequence: 1, resync: false },
      { sequence: 3, resync: true },
    ]);

    controller.abort();
    await watching;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  test("rejects changed events before the ready handshake and closes the socket", async () => {
    const socket = new FakeSocket();
    const watching = watchMachineFileOnce({
      machineId: "machine-1",
      path: "/workspace/readme.md",
      signal: new AbortController().signal,
      createSocket: async () => asWebSocket(socket),
      onInvalidate: () => {},
    });
    await Bun.sleep(0);
    socket.open();
    socket.serverMessage({ type: "changed", sequence: 1, resync: false });
    await expect(watching).rejects.toThrow("尚未就绪");
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  test("an abort while credentials are resolving closes a late socket without sending", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    let provideSocket!: (socket: WebSocket) => void;
    const watching = watchMachineFileOnce({
      machineId: "machine-1",
      path: "/workspace/readme.md",
      signal: controller.signal,
      createSocket: () =>
        new Promise<WebSocket>((resolve) => {
          provideSocket = resolve;
        }),
      onInvalidate: () => {},
    });
    await waitFor(() => typeof provideSocket === "function");
    controller.abort();
    provideSocket(asWebSocket(socket));
    await expect(watching).rejects.toMatchObject({ name: "AbortError" });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(socket.sent).toHaveLength(0);
  });
});
