import {
  openBinaryFileUploadSession,
  type BinaryFileUploadSession,
} from "@cloud-machine/workspace-ui/binary-file-upload";

import { gatewayWebSocketUrl } from "../host";
import { createMachineConnectionTicket } from "./connection-ticket";

export function createMachineUploadSession(
  machineId: string,
  signal?: AbortSignal,
): Promise<BinaryFileUploadSession> {
  return openBinaryFileUploadSession({
    signal,
    createSocket: async (socketSignal) => {
      socketSignal?.throwIfAborted();
      const ticket = await createMachineConnectionTicket(machineId, "upload");
      socketSignal?.throwIfAborted();
      return new WebSocket(
        gatewayWebSocketUrl(
          `/machines/${encodeURIComponent(machineId)}/upload?ticket=${encodeURIComponent(ticket)}`,
        ),
      );
    },
  });
}
