import { z } from "zod";

export const DESKTOP_OAUTH_CLIENT_ID = "renrencodex-desktop";
export const DESKTOP_OAUTH_REDIRECT_URI = "renrencodex://oauth/callback";

const clientIdSchema = z.literal(DESKTOP_OAUTH_CLIENT_ID);
const redirectUriSchema = z.literal(DESKTOP_OAUTH_REDIRECT_URI);
export const desktopCodeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const desktopCodeVerifierSchema = z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/);
export const desktopDeviceNameSchema = z.string().trim().min(1).max(100);

export const createDesktopAuthorizationCodeInputSchema = z.object({
  clientId: clientIdSchema,
  redirectUri: redirectUriSchema,
  codeChallenge: desktopCodeChallengeSchema,
  codeChallengeMethod: z.literal("S256"),
  deviceName: desktopDeviceNameSchema,
});

export const createDesktopAuthorizationCodeResponseSchema = z.object({
  authorizationCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresInSeconds: z.literal(300),
});

export const exchangeDesktopAuthorizationCodeInputSchema = z.object({
  grantType: z.literal("authorization_code"),
  clientId: clientIdSchema,
  redirectUri: redirectUriSchema,
  authorizationCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeVerifier: desktopCodeVerifierSchema,
});

export const desktopRefreshInputSchema = z.object({
  refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const desktopRevokeInputSchema = desktopRefreshInputSchema;

export const desktopTokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  tokenType: z.literal("Bearer"),
  expiresInSeconds: z.number().int().positive(),
});

export type CreateDesktopAuthorizationCodeInput = z.infer<
  typeof createDesktopAuthorizationCodeInputSchema
>;
export type CreateDesktopAuthorizationCodeResponse = z.infer<
  typeof createDesktopAuthorizationCodeResponseSchema
>;
export type ExchangeDesktopAuthorizationCodeInput = z.infer<
  typeof exchangeDesktopAuthorizationCodeInputSchema
>;
export type DesktopRefreshInput = z.infer<typeof desktopRefreshInputSchema>;
export type DesktopRevokeInput = z.infer<typeof desktopRevokeInputSchema>;
export type DesktopTokenResponse = z.infer<typeof desktopTokenResponseSchema>;
