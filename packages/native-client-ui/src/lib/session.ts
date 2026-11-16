import { getClientHost } from "../host";

export function restoreSession(): Promise<void> {
  return getClientHost().session.restore();
}

export function logout(): Promise<void> {
  return getClientHost().session.signOut();
}

export function getFreshAccessToken(
  options: { throwOnTransientError?: boolean } = {},
): Promise<string | null> {
  return getClientHost().session.getFreshAccessToken(options);
}
