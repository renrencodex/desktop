import { gatewayWebSocketUrl } from "../host";
import { createMachineConnectionTicket } from "./connection-ticket";

export async function createMachineWatchSocket(
  machineId: string,
  signal: AbortSignal,
): Promise<WebSocket> {
  signal.throwIfAborted();
  const ticket = await createMachineConnectionTicket(machineId, "watch");
  signal.throwIfAborted();
  return new WebSocket(
    gatewayWebSocketUrl(
      `/machines/${encodeURIComponent(machineId)}/watch?ticket=${encodeURIComponent(ticket)}`,
    ),
  );
}
