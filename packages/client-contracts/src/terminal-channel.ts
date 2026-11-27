import { z } from "zod";

import { RPC_ERROR_CLOSED, RPC_ERROR_TIMEOUT } from "./rpc-errors";

export const TERMINAL_ERROR_MACHINE_OFFLINE = "MACHINE_OFFLINE";

/** Gateway → Web terminal error; code is optional for rolling upgrades. */
export const terminalChannelErrorSchema = z.object({
  type: z.literal("error"),
  code: z.string().optional(),
  message: z.string().optional(),
});
export type TerminalChannelError = z.infer<typeof terminalChannelErrorSchema>;

/** `opened` metadata used during a rolling upgrade to bound the initial replay. */
export interface TerminalOpenedReplayMetadata {
  replayCompleteFollows?: boolean;
}

export const TERMINAL_REPLAY_COMPLETE = "replay_complete";
export const terminalReplayCompleteMessageSchema = z.object({
  type: z.literal(TERMINAL_REPLAY_COMPLETE),
});
export type TerminalReplayCompleteMessage = z.infer<typeof terminalReplayCompleteMessageSchema>;

/** Unknown/business errors must not create automatic attach/restart loops. */
export function isRetryableTerminalError(value: unknown): boolean {
  const parsed = terminalChannelErrorSchema.safeParse(value);
  if (!parsed.success) return false;
  const { code, message } = parsed.data;
  if (code !== undefined)
    return [TERMINAL_ERROR_MACHINE_OFFLINE, RPC_ERROR_TIMEOUT, RPC_ERROR_CLOSED].includes(code);
  return message === "machine offline";
}
