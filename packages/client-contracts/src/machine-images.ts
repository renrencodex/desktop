import { z } from "zod";

export const DEFAULT_MACHINE_IMAGE_ID = "cloud-machine-ubuntu-24.04";
export const RECOMMENDED_MACHINE_IMAGE_ID = "cloud-machine-ubuntu-26.04";
export const imageStartupSchema = z.enum(["systemd", "openrc"]);
export const imageLifecycleSchema = z.enum(["active", "candidate", "legacy"]);
export const machineImageSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  version: z.string().min(1),
  architecture: z.literal("x86_64"),
  description: z.string(),
  osId: z.string().min(1),
});
export type MachineImage = z.infer<typeof machineImageSchema>;
