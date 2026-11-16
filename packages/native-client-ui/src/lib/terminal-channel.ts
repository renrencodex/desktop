import { createMachineConnectionTicket } from "./connection-ticket";
import { gatewayWebSocketUrl } from "../host";

export interface StableTerminalRef {
  workspaceId: string;
  terminalTabId: string;
  paneId: string;
}

export async function destroyTerminalSession(
  machineId: string,
  ref: StableTerminalRef,
): Promise<void> {
  const ticket = await createMachineConnectionTicket(machineId, "terminal");
  const socket = new WebSocket(
    gatewayWebSocketUrl(
      `/machines/${encodeURIComponent(machineId)}/terminal?ticket=${encodeURIComponent(ticket)}`,
    ),
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      socket.close();
      reject(new Error("关闭终端超时，请重试"));
    }, 10_000);
    socket.onopen = () => socket.send(JSON.stringify({ type: "destroy", ...ref }));
    socket.onmessage = (event: MessageEvent<string>) => {
      let message: { type?: string; message?: string };
      try {
        message = JSON.parse(event.data) as { type?: string; message?: string };
      } catch {
        return;
      }
      if (message.type === "destroyed") {
        clearTimeout(timeout);
        socket.close();
        resolve();
      } else if (message.type === "error") {
        clearTimeout(timeout);
        socket.close();
        reject(new Error(message.message ?? "关闭终端失败"));
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error("无法连接终端服务"));
    };
  });
}
