import { z } from "zod";

import { machinePublicBandwidthMbpsSchema } from "@cloud-machine/client-contracts";

/** Android 原生会话直接使用邮箱密码登录，不复用 Desktop PKCE。 */
export const mobileDeviceNameSchema = z.string().trim().min(1).max(100);

const mobileCredentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(128),
  deviceName: mobileDeviceNameSchema,
});

export const mobileLoginInputSchema = mobileCredentialsSchema;

export const mobileRegisterInputSchema = mobileCredentialsSchema.extend({
  displayName: z.string().trim().min(1).max(100),
  verificationCode: z.string().regex(/^\d{6}$/),
});

export const mobileRefreshInputSchema = z.object({
  refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const mobileRevokeInputSchema = mobileRefreshInputSchema;

export const mobileUserSchema = z.object({
  id: z.string(),
  email: z.email(),
  displayName: z.string(),
  status: z.enum(["active", "suspended", "deleted"]),
  referralEnabled: z.boolean(),
  referralProgramExists: z.boolean(),
  machinePublicBandwidthMbps: machinePublicBandwidthMbpsSchema,
});

export const mobileTokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  tokenType: z.literal("Bearer"),
  expiresInSeconds: z.number().int().positive(),
  user: mobileUserSchema.optional(),
});

export type MobileLoginInput = z.infer<typeof mobileLoginInputSchema>;
export type MobileRegisterInput = z.infer<typeof mobileRegisterInputSchema>;
export type MobileRefreshInput = z.infer<typeof mobileRefreshInputSchema>;
export type MobileRevokeInput = z.infer<typeof mobileRevokeInputSchema>;
export type MobileTokenResponse = z.infer<typeof mobileTokenResponseSchema>;
