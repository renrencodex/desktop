import { afterAll, expect, test } from "bun:test";

import { RPC_ERROR_CLOSED } from "@cloud-machine/client-contracts";

const originalWebSocket = globalThis.WebSocket;
const originalWindow = globalThis.window;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closeCalls = 0;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.closeCalls += 1;
    this.onclose?.();
  }
}

Object.assign(globalThis, { WebSocket: FakeWebSocket, window: globalThis });

const { createTerminalSessionDestroyer } = await import("./terminal-channel");
const destroyTerminalSession = createTerminalSessionDestroyer({
  createTicket: async () => "ticket-value",
  createSocket: (url) => new FakeWebSocket(url) as unknown as WebSocket,
  socketUrl: (machineId, ticket) =>
    `wss://gateway.example.test/machines/${machineId}/terminal?ticket=${ticket}`,
});
const reference = { workspaceId: "workspace-1", terminalTabId: "terminal-1", paneId: "pane-1" };

afterAll(() => {
  Object.assign(globalThis, { WebSocket: originalWebSocket, window: originalWindow });
});

test("native destroy acknowledgement wins over the socket close caused by cleanup", async () => {
  const pending = destroyTerminalSession("machine-1", reference);
  await Bun.sleep(0);
  const socket = FakeWebSocket.instances.at(-1)!;
  expect(socket.url).toContain("wss://gateway.example.test/machines/machine-1/terminal");
  socket.onopen?.();
  expect(JSON.parse(socket.sent[0]!)).toEqual({ type: "destroy", ...reference });

  socket.onmessage?.({ data: JSON.stringify({ type: "destroyed" }) } as MessageEvent<string>);
  await expect(pending).resolves.toBeUndefined();
  expect(socket.closeCalls).toBe(1);
});

test("native destroy preserves Gateway errors and reports an early close once", async () => {
  const rejected = destroyTerminalSession("machine-1", reference);
  await Bun.sleep(0);
  const errorSocket = FakeWebSocket.instances.at(-1)!;
  errorSocket.onopen?.();
  errorSocket.onmessage?.({
    data: JSON.stringify({ type: "error", code: "HANDLER_ERROR", message: "destroy failed" }),
  } as MessageEvent<string>);
  await expect(rejected).rejects.toMatchObject({
    code: "HANDLER_ERROR",
    message: "destroy failed",
  });

  const closed = destroyTerminalSession("machine-1", reference);
  await Bun.sleep(0);
  FakeWebSocket.instances.at(-1)!.onclose?.();
  await expect(closed).rejects.toMatchObject({
    code: RPC_ERROR_CLOSED,
    message: "电脑通道已断开",
  });
});
