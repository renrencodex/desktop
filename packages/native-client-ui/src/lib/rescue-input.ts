import { RESCUE_MAX_INPUT_BYTES, type RescueClientMessage } from "@cloud-machine/client-contracts";
import { bytesToBase64 } from "./base64";

/** Split raw bytes, not JS characters; the PTY receives the original UTF-8 stream. */
export function sendRescueInput(
  bytes: Uint8Array,
  send: (message: RescueClientMessage) => boolean,
): void {
  for (let offset = 0; offset < bytes.length; offset += RESCUE_MAX_INPUT_BYTES) {
    if (
      !send({
        type: "input",
        data: bytesToBase64(bytes.subarray(offset, offset + RESCUE_MAX_INPUT_BYTES)),
      })
    )
      break;
  }
}
