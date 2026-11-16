import {
  DESKTOP_OAUTH_CLIENT_ID,
  DESKTOP_OAUTH_REDIRECT_URI,
  desktopCodeVerifierSchema,
} from "@cloud-machine/api-client";

export interface DesktopAuthorizationAttempt {
  readonly state: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

export interface DesktopAuthorizationCallback {
  readonly state: string;
  readonly authorizationCode: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 生成只应驻留在当前进程内存中的 OAuth state 与 PKCE S256 凭据。 */
export async function createDesktopAuthorizationAttempt(): Promise<DesktopAuthorizationAttempt> {
  const stateBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifierBytes = crypto.getRandomValues(new Uint8Array(64));
  const state = base64Url(stateBytes);
  const codeVerifier = base64Url(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64Url(new Uint8Array(digest));
  desktopCodeVerifierSchema.parse(codeVerifier);
  return { state, codeVerifier, codeChallenge };
}

export function buildDesktopAuthorizeUrl(
  webBaseUrl: string,
  attempt: DesktopAuthorizationAttempt,
  deviceName = "人人Codex Desktop",
): string {
  const url = new URL("/desktop/authorize", webBaseUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", DESKTOP_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", DESKTOP_OAUTH_REDIRECT_URI);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", attempt.codeChallenge);
  url.searchParams.set("state", attempt.state);
  url.searchParams.set("device_name", deviceName);
  return url.toString();
}

/**
 * Deep Link 是不可信输入：只接受固定 scheme/authority/path、恰好一个 code/state，
 * 且拒绝 fragment、userinfo、port 与额外参数。
 */
export function parseDesktopAuthorizationCallback(
  value: string,
): DesktopAuthorizationCallback | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "renrencodex:" ||
    url.hostname !== "oauth" ||
    url.pathname !== "/callback" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    return null;
  }
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== 2 ||
    keys.filter((key) => key === "code").length !== 1 ||
    keys.filter((key) => key === "state").length !== 1
  ) {
    return null;
  }
  const authorizationCodes = url.searchParams.getAll("code");
  const states = url.searchParams.getAll("state");
  if (authorizationCodes.length !== 1 || states.length !== 1) return null;
  const authorizationCode = authorizationCodes[0]!;
  const state = states[0]!;
  if (!/^[A-Za-z0-9_-]{43}$/.test(authorizationCode) || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    return null;
  }
  return { authorizationCode, state };
}
