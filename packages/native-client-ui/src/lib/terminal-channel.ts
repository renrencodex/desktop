import {
  RPC_ERROR_CLOSED,
  RPC_ERROR_TIMEOUT,
  terminalChannelErrorSchema,
} from "@cloud-machine/client-contracts";

import { createMachineConnectionTicket } from "./connection-ticket";
import { gatewayWebSocketUrl } from "../host";

export interface StableTerminalRef {
  workspaceId: string;
  terminalTabId: string;
  paneId: string;
}

interface TerminalSessionDestroyDependencies {
  createTicket(machineId: string): Promise<string>;
  createSocket(url: string): WebSocket;
  socketUrl(machineId: string, ticket: string): string;
}

export function createTerminalSessionDestroyer(deps: TerminalSessionDestroyDependencies) {
  return async (machineId: string, ref: StableTerminalRef): Promise<void> => {
    const ticket = await deps.createTicket(machineId);
    const socket = deps.createSocket(deps.socketUrl(machineId, ticket));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error & { code?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          // The socket may still be transitioning out of CONNECTING.
        }
        if (error) reject(error);
        else resolve();
      };
      const codedError = (code: string, message: string) =>
        Object.assign(new Error(message), { code });
      const timeout = window.setTimeout(() => {
        finish(codedError(RPC_ERROR_TIMEOUT, "关闭终端超时，请重试"));
      }, 35_000);
      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({ type: "destroy", ...ref }));
        } catch {
          finish(codedError("CONNECT_FAILED", "无法连接终端服务"));
        }
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        let message: unknown;
        try {
          message = JSON.parse(event.data) as unknown;
        } catch {
          return;
        }
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "destroyed"
        ) {
          finish();
          return;
        }
        const terminalError = terminalChannelErrorSchema.safeParse(message);
        if (terminalError.success) {
          finish(
            codedError(
              terminalError.data.code ?? "TERMINAL_DESTROY_FAILED",
              terminalError.data.message ?? "关闭终端失败",
            ),
          );
        }
      };
      socket.onerror = () => finish(codedError("CONNECT_FAILED", "无法连接终端服务"));
      socket.onclose = () => finish(codedError(RPC_ERROR_CLOSED, "电脑通道已断开"));
    });
  };
}

export const destroyTerminalSession = createTerminalSessionDestroyer({
  createTicket: (machineId) => createMachineConnectionTicket(machineId, "terminal"),
  createSocket: (url) => new WebSocket(url),
  socketUrl: (machineId, ticket) =>
    gatewayWebSocketUrl(
      `/machines/${encodeURIComponent(machineId)}/terminal?ticket=${encodeURIComponent(ticket)}`,
    ),
});
