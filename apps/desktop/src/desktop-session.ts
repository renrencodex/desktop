import { isApiError } from "@cloud-machine/api-client";

export const DESKTOP_CONNECTIVITY_RETRY_DELAYS_MS = [500, 1_500] as const;
export const DESKTOP_CONNECTIVITY_TIMEOUT_MS = 3_000;

export class DesktopConnectivityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DesktopConnectivityError";
  }
}

export class DesktopSessionStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DesktopSessionStorageError";
  }
}

interface DesktopConnectivityOptions {
  fetchImpl?: typeof fetch;
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}

export interface DesktopSessionRecoveryDependencies<TUser> {
  readRefreshToken(): Promise<string | null>;
  setRefreshToken(value: string | null): void;
  probeConnectivity(): Promise<void>;
  refresh(): Promise<unknown>;
  readUser(): Promise<TUser>;
}

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

function connectivityEndpoint(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/$/, "")}/api/v1/auth/me`;
}

/**
 * Probe the API with an idempotent, unauthenticated GET. A reachable API may
 * answer 401/403; no access or refresh token is sent, so bounded retries are
 * safe even when the response to a previous attempt was lost.
 */
export async function probeDesktopApiConnectivity(
  apiBaseUrl: string,
  options: DesktopConnectivityOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const retryDelaysMs = options.retryDelaysMs ?? DESKTOP_CONNECTIVITY_RETRY_DELAYS_MS;
  const timeoutMs = options.timeoutMs ?? DESKTOP_CONNECTIVITY_TIMEOUT_MS;
  const wait = options.wait ?? waitFor;
  const endpoint = connectivityEndpoint(apiBaseUrl);
  let lastFailure: unknown;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (attempt > 0) await wait(retryDelaysMs[attempt - 1]!);
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(
      () => controller.abort(new Error("Desktop API connectivity probe timed out")),
      timeoutMs,
    );
    try {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if ([200, 401, 403].includes(response.status)) return;
      lastFailure = new Error(`unexpected API probe status ${response.status}`);
    } catch (error) {
      lastFailure = error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  throw new DesktopConnectivityError("Desktop API connectivity probe failed", {
    cause: lastFailure,
  });
}

/**
 * Restore a durable Desktop session. Only the safe connectivity probe retries;
 * refresh rotates a token and therefore runs exactly once per recovery call.
 */
export async function recoverDesktopSession<TUser>(
  dependencies: DesktopSessionRecoveryDependencies<TUser>,
): Promise<TUser | null> {
  let refreshToken: string | null;
  try {
    refreshToken = await dependencies.readRefreshToken();
    dependencies.setRefreshToken(refreshToken);
  } catch (error) {
    if (error instanceof DesktopSessionStorageError) throw error;
    throw new DesktopSessionStorageError("Desktop secure storage read failed", { cause: error });
  }
  if (!refreshToken) return null;

  await dependencies.probeConnectivity();
  try {
    await dependencies.refresh();
    return await dependencies.readUser();
  } catch (error) {
    if (isApiError(error) && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
}

export function desktopSessionErrorMessage(error: unknown): string {
  if (error instanceof DesktopSessionStorageError) {
    return "无法访问系统安全存储，请重启 Desktop 后重试。";
  }
  if (
    error instanceof DesktopConnectivityError ||
    error instanceof TypeError ||
    (error instanceof Error && error.name === "AbortError") ||
    (isApiError(error) && (error.status === 408 || error.status === 429 || error.status >= 500))
  ) {
    return "暂时无法连接人人Codex服务，请检查网络后重试。本地登录信息未被清除。";
  }
  return "安全会话恢复失败，请重试。";
}
