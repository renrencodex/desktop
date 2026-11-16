import {
  DESKTOP_OAUTH_CLIENT_ID,
  DESKTOP_OAUTH_REDIRECT_URI,
  createDesktopAuthorizationCodeInputSchema,
  type CreateDesktopAuthorizationCodeInput,
} from "@cloud-machine/api-client";

export interface DesktopAuthorizeRequest {
  input: CreateDesktopAuthorizationCodeInput;
  state: string;
}

/** 解析系统浏览器传入的 OAuth 参数；redirect_uri 只接受编译期白名单。 */
export function parseDesktopAuthorizeRequest(
  params: URLSearchParams,
): DesktopAuthorizeRequest | null {
  if (
    params.get("response_type") !== "code" ||
    params.get("client_id") !== DESKTOP_OAUTH_CLIENT_ID ||
    params.get("redirect_uri") !== DESKTOP_OAUTH_REDIRECT_URI ||
    params.get("code_challenge_method") !== "S256"
  ) {
    return null;
  }
  const state = params.get("state");
  const stateHasControlCharacter =
    state !== null &&
    Array.from(state).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
  if (!state || state.length > 512 || stateHasControlCharacter) return null;
  const parsed = createDesktopAuthorizationCodeInputSchema.safeParse({
    clientId: params.get("client_id"),
    redirectUri: params.get("redirect_uri"),
    codeChallenge: params.get("code_challenge"),
    codeChallengeMethod: params.get("code_challenge_method"),
    deviceName: params.get("device_name") ?? "人人Codex Desktop",
  });
  return parsed.success ? { input: parsed.data, state } : null;
}

export function buildDesktopCallbackUrl(authorizationCode: string, state: string): string {
  const callback = new URL(DESKTOP_OAUTH_REDIRECT_URI);
  callback.searchParams.set("code", authorizationCode);
  callback.searchParams.set("state", state);
  return callback.toString();
}

/** 登录页只允许返回 Desktop authorize 页面，禁止开放重定向。 */
export function desktopAuthorizeReturnPath(candidate: string | null): string | null {
  if (!candidate) return null;
  const base = new URL("https://web.invalid");
  let parsed: URL;
  try {
    parsed = new URL(candidate, base);
  } catch {
    return null;
  }
  if (parsed.origin !== base.origin || parsed.pathname !== "/desktop/authorize" || parsed.hash) {
    return null;
  }
  return `${parsed.pathname}${parsed.search}`;
}
