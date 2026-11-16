import { z } from "zod";

export const RESCUE_MAX_INPUT_BYTES = 48 * 1024;
export const rescueSizeSchema = z.object({
  cols: z.number().int().min(2).max(500).default(80),
  rows: z.number().int().min(2).max(300).default(24),
});
export const rescueSessionSchema = z.object({
  sessionId: z.uuid(),
  ticket: z.string(),
  ticketExpiresAt: z.string(),
  expiresAt: z.string(),
});
export type RescueSession = z.infer<typeof rescueSessionSchema>;
export type RescueSize = z.infer<typeof rescueSizeSchema>;
export const rescueClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max((RESCUE_MAX_INPUT_BYTES / 3) * 4) }),
  rescueSizeSchema.extend({ type: z.literal("resize") }),
  z.object({ type: z.literal("close") }),
]);
export const rescueServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("opened") }),
  z.object({ type: z.literal("output"), data: z.string().max(131072) }),
  z.object({ type: z.literal("exit"), code: z.number().int() }),
  z.object({ type: z.literal("error"), message: z.string().max(200) }),
]);
export type RescueClientMessage = z.infer<typeof rescueClientMessageSchema>;
export type RescueServerMessage = z.infer<typeof rescueServerMessageSchema>;
