import { z } from "zod";

export const MACHINE_CONNECTION_CHANNELS = [
  "terminal",
  "rpc",
  "upload",
  "download",
  "search",
  "watch",
] as const;

export const machineConnectionChannelSchema = z.enum(MACHINE_CONNECTION_CHANNELS);
export type MachineConnectionChannel = z.infer<typeof machineConnectionChannelSchema>;

export const createMachineConnectionTicketInputSchema = z
  .object({ channel: machineConnectionChannelSchema })
  .strict();
export type CreateMachineConnectionTicketInput = z.infer<
  typeof createMachineConnectionTicketInputSchema
>;

export const machineConnectionTicketSchema = z
  .object({
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type MachineConnectionTicket = z.infer<typeof machineConnectionTicketSchema>;
