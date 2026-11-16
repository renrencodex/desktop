import type { MachineConnectionChannel } from "@cloud-machine/client-contracts";

import { getClientHost } from "../host";

export { isDefinitiveConnectionTicketRejection } from "@cloud-machine/api-client";

export async function createMachineConnectionTicket(
  machineId: string,
  channel: MachineConnectionChannel,
): Promise<string> {
  const response = await getClientHost().api.machines.createConnectionTicket(
    machineId,
    channel,
    crypto.randomUUID(),
  );
  return response.ticket;
}
