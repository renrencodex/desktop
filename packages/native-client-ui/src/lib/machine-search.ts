import { createMachineConnectionTicket } from "./connection-ticket";
import { gatewayWebSocketUrl } from "../host";

export async function createMachineSearchSocket(
  machineId: string,
  signal: AbortSignal,
): Promise<WebSocket> {
  signal.throwIfAborted();
  const ticket = await createMachineConnectionTicket(machineId, "search");
  signal.throwIfAborted();
  return new WebSocket(
    gatewayWebSocketUrl(
      `/machines/${encodeURIComponent(machineId)}/search?ticket=${encodeURIComponent(ticket)}`,
    ),
  );
}
