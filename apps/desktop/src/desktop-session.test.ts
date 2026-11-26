import { expect, test } from "bun:test";
import { ApiError } from "@cloud-machine/api-client";

import {
  DesktopConnectivityError,
  DesktopSessionStorageError,
  desktopSessionErrorMessage,
  probeDesktopApiConnectivity,
  recoverDesktopSession,
} from "./desktop-session";

test("skips all network work when secure storage has no refresh token", async () => {
  const calls: string[] = [];
  const result = await recoverDesktopSession({
    readRefreshToken: async () => null,
    setRefreshToken: (value) => calls.push(`token:${value}`),
    probeConnectivity: async () => {
      calls.push("probe");
    },
    refresh: async () => {
      calls.push("refresh");
    },
    readUser: async () => {
      calls.push("user");
      return { id: "user-1" };
    },
  });

  expect(result).toBeNull();
  expect(calls).toEqual(["token:null"]);
});

test("restores in order and runs refresh only once", async () => {
  const calls: string[] = [];
  const result = await recoverDesktopSession({
    readRefreshToken: async () => "refresh-1",
    setRefreshToken: (value) => calls.push(`token:${value}`),
    probeConnectivity: async () => {
      calls.push("probe");
    },
    refresh: async () => {
      calls.push("refresh");
    },
    readUser: async () => {
      calls.push("user");
      return { id: "user-1" };
    },
  });

  expect(result).toEqual({ id: "user-1" });
  expect(calls).toEqual(["token:refresh-1", "probe", "refresh", "user"]);
});

test("the connectivity probe retries independent token-free requests", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const delays: number[] = [];
  let attempts = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    attempts += 1;
    requests.push({ url: String(input), init });
    if (attempts < 3) throw new TypeError("Failed to fetch");
    return new Response(null, { status: 401 });
  }) as typeof fetch;

  await probeDesktopApiConnectivity("https://renrencodex.com/", {
    fetchImpl,
    wait: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  expect(delays).toEqual([500, 1_500]);
  expect(requests).toHaveLength(3);
  for (const request of requests) {
    expect(request.url).toBe("https://renrencodex.com/api/v1/auth/me");
    expect(request.init).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
    });
    expect(new Headers(request.init?.headers).has("authorization")).toBe(false);
  }
});

test("does not attempt refresh when all safe connectivity probes fail", async () => {
  let refreshCalls = 0;
  await expect(
    recoverDesktopSession({
      readRefreshToken: async () => "refresh-1",
      setRefreshToken: () => undefined,
      probeConnectivity: async () => {
        throw new DesktopConnectivityError("offline");
      },
      refresh: async () => {
        refreshCalls += 1;
      },
      readUser: async () => ({ id: "user-1" }),
    }),
  ).rejects.toBeInstanceOf(DesktopConnectivityError);
  expect(refreshCalls).toBe(0);
});

test("never retries a refresh request after an ambiguous transport failure", async () => {
  let refreshCalls = 0;
  const inMemoryRefreshTokens: Array<string | null> = [];
  await expect(
    recoverDesktopSession({
      readRefreshToken: async () => "refresh-1",
      setRefreshToken: (value) => {
        inMemoryRefreshTokens.push(value);
      },
      probeConnectivity: async () => undefined,
      refresh: async () => {
        refreshCalls += 1;
        throw new TypeError("Failed to fetch");
      },
      readUser: async () => ({ id: "user-1" }),
    }),
  ).rejects.toBeInstanceOf(TypeError);
  expect(refreshCalls).toBe(1);
  expect(inMemoryRefreshTokens).toEqual(["refresh-1"]);
});

test("treats an explicit refresh rejection as an expired session", async () => {
  const result = await recoverDesktopSession({
    readRefreshToken: async () => "refresh-1",
    setRefreshToken: () => undefined,
    probeConnectivity: async () => undefined,
    refresh: async () => {
      throw new ApiError(401, "SESSION_REVOKED", "revoked");
    },
    readUser: async () => ({ id: "user-1" }),
  });
  expect(result).toBeNull();
});

test("wraps secure storage failures and exposes only localized startup messages", async () => {
  const storageFailure = await recoverDesktopSession({
    readRefreshToken: async () => {
      throw new Error("keychain details must stay internal");
    },
    setRefreshToken: () => undefined,
    probeConnectivity: async () => undefined,
    refresh: async () => undefined,
    readUser: async () => ({ id: "user-1" }),
  }).catch((error: unknown) => error);

  expect(storageFailure).toBeInstanceOf(DesktopSessionStorageError);
  expect(desktopSessionErrorMessage(storageFailure)).toBe(
    "无法访问系统安全存储，请重启 Desktop 后重试。",
  );
  expect(desktopSessionErrorMessage(new TypeError("Failed to fetch"))).toBe(
    "暂时无法连接人人Codex服务，请检查网络后重试。本地登录信息未被清除。",
  );
  expect(desktopSessionErrorMessage(new Error("internal detail"))).toBe(
    "安全会话恢复失败，请重试。",
  );
});
