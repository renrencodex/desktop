/**
 * api-client 单元测试：mock fetch 验证请求路径/method/body/header、
 * 错误映射（ApiError code/status）、401 → refresh → 重放逻辑（含并发去重）。
 */
import { describe, expect, test } from "bun:test";

import { ApiError, createApiClient, type ApiClientOptions } from "./index";
import type { WorkbenchLayout } from "./types";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials?: string;
  body?: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 构造 mock fetch：handler 按调用返回响应；记录所有调用。 */
function mockFetch(handler: (call: RecordedCall, index: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      credentials: init?.credentials,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function createClient(
  fetchImpl: typeof fetch,
  initialToken: string | null = "token-1",
  withAuthLock?: ApiClientOptions["withAuthLock"],
) {
  let token = initialToken;
  const expired: string[] = [];
  const client = createApiClient({
    baseUrl: "http://api.test/",
    getAccessToken: () => token,
    setAccessToken: (t) => {
      token = t;
    },
    onSessionExpired: () => expired.push("expired"),
    fetchImpl,
    withAuthLock,
  });
  return {
    client,
    getToken: () => token,
    expired,
  };
}

describe("请求构造", () => {
  test("公开价格目录不携带登录令牌且不触发认证刷新", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse(200, {
        available: true,
        pricingContext: "platform",
        billingPeriods: ["monthly"],
        plans: [],
      }),
    );
    const { client } = createClient(fetchImpl, "private-token");

    await client.plans.publicCatalog();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "http://api.test/api/v1/public/plans",
    });
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  test("消息摘要限制条数并通过幂等全部已读接口更新状态", async () => {
    const { calls, fetchImpl } = mockFetch((call) =>
      call.method === "GET"
        ? jsonResponse(200, { items: [], unreadCount: 0 })
        : jsonResponse(200, { updated: 3, readAt: "2026-10-25T12:00:00.000Z" }),
    );
    const { client } = createClient(fetchImpl);

    await client.account.getNotificationSummary(12);
    const result = await client.account.markAllNotificationsRead();

    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "http://api.test/api/v1/account/notifications/summary?limit=12",
    });
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: "http://api.test/api/v1/account/notifications/read-all",
    });
    expect(calls[1]!.headers["x-requested-with"]).toBe("fetch");
    expect(result.updated).toBe(3);
  });

  test("专属域名注册、交接和定价写入使用对应接口与幂等键", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse(200, {
        active: true,
        label: "affiliate",
        registrationPath: "/register",
        themeId: "classic",
        handoffToken: "token",
        handoffUrl: "https://renrencodex.com/registration-handoff#token=token",
        replayed: false,
      }),
    );
    const { client } = createClient(fetchImpl);
    await client.auth.referralDomainContext();
    await client.auth.registerFromReferralDomain(
      {
        email: "new-invitee@example.com",
        verificationCode: "123456",
        password: "password-123",
        displayName: "New User",
      },
      "11111111-1111-4111-8111-111111111111",
    );
    await client.auth.completeReferralDomainHandoff(
      "signed-secret-token",
      "22222222-2222-4222-8222-222222222222",
    );
    await client.account.referrals.updateDomain("affiliate", "domain-key");
    await client.account.referrals.updatePageTheme("anime-cel", "theme-key");
    await client.account.referrals.updateSalePrice("plan/1", 3900, "price-key");

    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "http://api.test/api/v1/referral-domain/context",
    });
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: "http://api.test/api/v1/auth/referral-domain/register",
      body: {
        email: "new-invitee@example.com",
        verificationCode: "123456",
        password: "password-123",
        displayName: "New User",
      },
    });
    expect(calls[1]!.headers["idempotency-key"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(calls[2]).toMatchObject({
      method: "POST",
      url: "http://api.test/api/v1/auth/referral-domain/handoff",
      body: { token: "signed-secret-token" },
    });
    expect(calls[2]!.headers["idempotency-key"]).toBe("22222222-2222-4222-8222-222222222222");
    expect(calls[3]).toMatchObject({
      method: "PUT",
      url: "http://api.test/api/v1/account/referrals/domain",
      body: { label: "affiliate" },
    });
    expect(calls[3]!.headers["idempotency-key"]).toBe("domain-key");
    expect(calls[4]).toMatchObject({
      method: "PUT",
      url: "http://api.test/api/v1/account/referrals/page-theme",
      body: { themeId: "anime-cel" },
    });
    expect(calls[4]!.headers["idempotency-key"]).toBe("theme-key");
    expect(calls[5]).toMatchObject({
      method: "PUT",
      url: "http://api.test/api/v1/account/referrals/prices/plan%2F1",
      body: { salePriceCents: 3900 },
    });
    expect(calls[5]!.headers["idempotency-key"]).toBe("price-key");
  });

  test("推广列表将页大小和不透明游标编码到查询参数", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse(200, { items: [], nextCursor: null, pagination: null }),
    );
    const { client } = createClient(fetchImpl);
    const options = { limit: 25, cursor: "cursor/with+symbols=" };

    await client.account.referrals.users(options);
    await client.account.referrals.orders(options);
    await client.account.referrals.commissions(options);
    await client.account.referrals.settlements(options);
    await client.account.referrals.payouts(options);

    expect(calls.map((call) => call.url)).toEqual([
      "http://api.test/api/v1/account/referrals/users?limit=25&cursor=cursor%2Fwith%2Bsymbols%3D",
      "http://api.test/api/v1/account/referrals/orders?limit=25&cursor=cursor%2Fwith%2Bsymbols%3D",
      "http://api.test/api/v1/account/referrals/commissions?limit=25&cursor=cursor%2Fwith%2Bsymbols%3D",
      "http://api.test/api/v1/account/referrals/settlements?limit=25&cursor=cursor%2Fwith%2Bsymbols%3D",
      "http://api.test/api/v1/account/referrals/payouts?limit=25&cursor=cursor%2Fwith%2Bsymbols%3D",
    ]);
  });

  test("推广列表将页码和每页条数编码到查询参数", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse(200, {
        items: [],
        nextCursor: null,
        pagination: { page: 3, pageSize: 20, total: 41, totalPages: 3 },
      }),
    );
    const { client } = createClient(fetchImpl);
    const options = { page: 3, pageSize: 20 } as const;

    await client.account.referrals.users(options);
    await client.account.referrals.orders(options);
    await client.account.referrals.commissions(options);
    await client.account.referrals.settlements(options);
    await client.account.referrals.payouts(options);

    expect(calls.map((call) => call.url)).toEqual([
      "http://api.test/api/v1/account/referrals/users?page=3&pageSize=20",
      "http://api.test/api/v1/account/referrals/orders?page=3&pageSize=20",
      "http://api.test/api/v1/account/referrals/commissions?page=3&pageSize=20",
      "http://api.test/api/v1/account/referrals/settlements?page=3&pageSize=20",
      "http://api.test/api/v1/account/referrals/payouts?page=3&pageSize=20",
    ]);
  });

  test("推广收款绑定使用目标资源、短令牌和独立幂等键", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, {}));
    const { client } = createClient(fetchImpl);

    await client.account.referrals.createPayoutBindingSession("create-binding-key");
    await client.account.referrals.getPayoutBindingSession("binding/id", "token/+?=");
    await client.account.referrals.authorizePayoutBinding("binding/id", "token/+?=", "张三");
    await client.account.referrals.getWechatJsapiConfig(
      "https://renrencodex.com/referrals/wechat-bind?id=binding/id",
    );
    await client.account.referrals.closeWechatAuthorization(
      "authorization/id",
      "close-binding-key",
    );

    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "http://api.test/api/v1/account/referrals/payout-binding-sessions",
    });
    expect(calls[0]!.headers["idempotency-key"]).toBe("create-binding-key");
    expect(calls[1]).toMatchObject({
      method: "GET",
      url: "http://api.test/api/v1/account/referrals/payout-binding-sessions/binding%2Fid?token=token%2F%2B%3F%3D",
    });
    expect(calls[2]).toMatchObject({
      method: "POST",
      url: "http://api.test/api/v1/account/referrals/payout-binding-sessions/binding%2Fid/authorize",
      body: { token: "token/+?=", recipientName: "张三" },
    });
    expect(calls[3]!.url).toBe(
      "http://api.test/api/v1/account/referrals/wechat-jsapi-config?url=https%3A%2F%2Frenrencodex.com%2Freferrals%2Fwechat-bind%3Fid%3Dbinding%2Fid",
    );
    expect(calls[4]).toMatchObject({
      method: "POST",
      url: "http://api.test/api/v1/account/referrals/wechat-authorizations/authorization%2Fid/close",
    });
    expect(calls[4]!.headers["idempotency-key"]).toBe("close-binding-key");
  });

  test("CLI Store install and uninstall use explicit allowlisted input and idempotency headers", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse(202, {}));
    const { client } = createClient(fetchImpl);
    await client.cliStore.inventory("machine/a");
    await client.cliStore.operate(
      "machine/a",
      { appId: "codex", action: "install" },
      "install-key",
    );
    await client.cliStore.operate(
      "machine/a",
      { appId: "codex", action: "uninstall" },
      "remove-key",
    );
    await client.cliStore.cancel("machine/a", "cli/operation");
    expect(calls[0]!.url).toBe("http://api.test/api/v1/machines/machine%2Fa/cli-apps");
    expect(calls[1]!.headers["idempotency-key"]).toBe("install-key");
    expect(calls[2]!.headers["idempotency-key"]).toBe("remove-key");
    expect(calls[2]!.body).toEqual({ appId: "codex", action: "uninstall" });
    expect(calls[2]!.headers["x-requested-with"]).toBe("fetch");
    expect(calls[3]).toMatchObject({
      method: "DELETE",
      url: "http://api.test/api/v1/machines/machine%2Fa/cli-apps/operations/cli%2Foperation",
    });
    expect(calls[3]!.headers["x-requested-with"]).toBe("fetch");
  });
  test("注册验证码与最终注册使用独立请求并携带验证码", async () => {
    const { calls, fetchImpl } = mockFetch((_call, index) =>
      index === 0
        ? jsonResponse(202, { expiresInSeconds: 600, resendAfterSeconds: 60 })
        : jsonResponse(201, {
            accessToken: "token",
            user: {
              id: "u1",
              email: "user@example.com",
              displayName: "User",
              status: "active",
            },
          }),
    );
    const { client } = createClient(fetchImpl, null);

    await client.auth.sendRegistrationCode({ email: "user@example.com" });
    await client.auth.register({
      email: "user@example.com",
      verificationCode: "123456",
      password: "password-123",
      displayName: "User",
    });

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "http://api.test/api/v1/auth/registration-code"],
      ["POST", "http://api.test/api/v1/auth/register"],
    ]);
    expect(calls[1]!.body).toEqual({
      email: "user@example.com",
      verificationCode: "123456",
      password: "password-123",
      displayName: "User",
    });
  });

  test("GET 带 Bearer，不带 x-requested-with；POST 带 CSRF 头与 JSON body", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, []));
    const { client } = createClient(fetchImpl);

    await client.account.getQuota();
    expect(calls[0]!.url).toBe("http://api.test/api/v1/account/quota");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.authorization).toBe("Bearer token-1");
    expect(calls[0]!.headers["x-requested-with"]).toBeUndefined();
    expect(calls[0]!.credentials).toBe("include");

    await client.machines.create({ name: "dev", planId: "p1", imageId: "img" });
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.headers["x-requested-with"]).toBe("fetch");
    expect(calls[1]!.headers["content-type"]).toContain("application/json");
    expect(calls[1]!.body).toEqual({ name: "dev", planId: "p1", imageId: "img" });
  });

  test("machines.list 使用当前账号；create 带 Idempotency-Key；update/delete 使用正确方法", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, {}));
    const { client } = createClient(fetchImpl);

    await client.machines.list();
    expect(calls[0]!.url).toBe("http://api.test/api/v1/machines");

    await client.machines.create(
      { name: "dev", planId: "p1", imageId: "img" },
      { idempotencyKey: "key-123" },
    );
    expect(calls[1]!.headers["idempotency-key"]).toBe("key-123");
    expect(calls[1]!.body).toEqual({
      name: "dev",
      planId: "p1",
      imageId: "img",
    });

    await client.machines.update("m/1", { name: "renamed" });
    expect(calls[2]!.url).toBe("http://api.test/api/v1/machines/m%2F1");
    expect(calls[2]!.method).toBe("PATCH");
    expect(calls[2]!.body).toEqual({ name: "renamed" });
    expect(calls[2]!.headers["x-requested-with"]).toBe("fetch");

    await client.machines.delete("m/1", "quote-1");
    expect(calls[3]!.url).toBe("http://api.test/api/v1/machines/m%2F1");
    expect(calls[3]!.method).toBe("DELETE");
    expect(calls[3]!.body).toEqual({ deletionQuoteId: "quote-1" });

    await client.machines.rebuild("m1", { sshKeyIds: ["k1"] });
    expect(calls[4]!.url).toBe("http://api.test/api/v1/machines/m1/rebuild");
    expect(calls[4]!.method).toBe("POST");
    expect(calls[4]!.body).toEqual({ sshKeyIds: ["k1"] });

    await client.machines.rebuild("m1");
    expect(calls[5]!.body).toEqual({});

    await client.machines.provisioning("m/1");
    expect(calls[6]!.url).toBe("http://api.test/api/v1/machines/m%2F1/provisioning");
    expect(calls[6]!.method).toBe("GET");

    await client.machines.retryProvisioning("m/1", "retry-123");
    expect(calls[7]!.url).toBe("http://api.test/api/v1/machines/m%2F1/provisioning/retry");
    expect(calls[7]!.method).toBe("POST");
    expect(calls[7]!.headers["idempotency-key"]).toBe("retry-123");
  });

  test("删除电脑先获取报价并在删除请求携带报价 ID", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, {}));
    const { client } = createClient(fetchImpl);

    await client.machines.getDeletionQuote("m/1");
    await client.machines.delete("m/1", "quote-1");

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "http://api.test/api/v1/machines/m%2F1/deletion-quote"],
      ["DELETE", "http://api.test/api/v1/machines/m%2F1"],
    ]);
    expect(calls[1]!.body).toEqual({ deletionQuoteId: "quote-1" });
  });

  test("machines.events 拼接 limit/before 查询参数；无参数时不带 query", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse(200, { events: [], nextBefore: null }),
    );
    const { client } = createClient(fetchImpl);

    await client.machines.events("m1");
    expect(calls[0]!.url).toBe("http://api.test/api/v1/machines/m1/events");

    await client.machines.events("m1", { limit: 20 });
    expect(calls[1]!.url).toBe("http://api.test/api/v1/machines/m1/events?limit=20");

    const before = "2026-08-20T12:00:00.000Z";
    await client.machines.events("m1", { limit: 50, before });
    expect(calls[2]!.url).toBe(
      `http://api.test/api/v1/machines/m1/events?limit=50&before=${encodeURIComponent(before)}`,
    );
    expect(calls[2]!.method).toBe("GET");
    expect(calls[2]!.headers["x-requested-with"]).toBeUndefined();
  });

  test("Machine Gateway 连接票据绑定通道并携带调用方幂等键", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse(201, {
        ticket: "t".repeat(43),
        expiresAt: "2026-11-16T00:00:30.000Z",
      }),
    );
    const { client } = createClient(fetchImpl);

    await client.machines.createConnectionTicket("machine/one", "terminal", "connection-key-123");

    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "http://api.test/api/v1/machines/machine%2Fone/connection-tickets",
      body: { channel: "terminal" },
    });
    expect(calls[0]!.headers["idempotency-key"]).toBe("connection-key-123");
  });

  test("端口列表和禁用/放开使用保留的 API 路径", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, []));
    const { client } = createClient(fetchImpl);

    await client.ports.list("machine/one");
    await client.ports.setVisibility("machine/one", 3080, "public");

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "http://api.test/api/v1/machines/machine%2Fone/ports"],
      ["PUT", "http://api.test/api/v1/machines/machine%2Fone/ports/3080/visibility"],
    ]);
    expect(calls[1]!.body).toEqual({ visibility: "public" });
  });

  test("Workspace v2 与 workbench layout 方法构造正确路径和请求体", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, {}));
    const { client } = createClient(fetchImpl);
    const layout: WorkbenchLayout = {
      version: 9,
      workspacePane: { tabs: [], activeTabId: null },
    };

    await client.workspaces.create("m/1", {
      name: "Frontend",
      path: "/workspace/app",
      mode: "create",
    });
    await client.workspaces.get("w/1");
    await client.workspaces.update("w/1", { name: "Web" });
    await client.workspaces.status("w/1");
    await client.workspaces.delete("w/1");
    await client.workspaces.delete("w/1", { deleteFiles: true });
    await client.workbench.getLayout("w/1");
    await client.workbench.saveLayout("w/1", { layout, expectedRevision: 3 });

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "http://api.test/api/v1/machines/m%2F1/workspaces"],
      ["GET", "http://api.test/api/v1/workspaces/w%2F1"],
      ["PATCH", "http://api.test/api/v1/workspaces/w%2F1"],
      ["GET", "http://api.test/api/v1/workspaces/w%2F1/status"],
      ["DELETE", "http://api.test/api/v1/workspaces/w%2F1"],
      ["DELETE", "http://api.test/api/v1/workspaces/w%2F1?deleteFiles=true"],
      ["GET", "http://api.test/api/v1/workspaces/w%2F1/workbench-layout"],
      ["PUT", "http://api.test/api/v1/workspaces/w%2F1/workbench-layout"],
    ]);
    expect(calls[0]!.body).toEqual({ name: "Frontend", path: "/workspace/app", mode: "create" });
    expect(calls[7]!.body).toEqual({ layout, expectedRevision: 3 });
  });

  test("Git 项目创建会传递凭据保存选项和幂等键", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse(202, {}));
    const { client } = createClient(fetchImpl);
    const input = {
      name: "Private repository",
      path: "/root/workspace/private",
      repositoryUrl: "https://git.example.com/team/private.git",
      credentials: { username: "git-user", token: "synthetic-token" },
      saveCredentials: true,
    };

    await client.workspaces.createFromGit("machine/one", input, "git-import-key");

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "http://api.test/api/v1/machines/machine%2Fone/workspace-git-imports",
    );
    expect(calls[0]!.headers["idempotency-key"]).toBe("git-import-key");
    expect(calls[0]!.body).toEqual(input);
  });

  test("订单、钱包与订阅方法携带正确路径和幂等键", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, {}));
    const { client } = createClient(fetchImpl);

    await client.account.getWallet();
    await client.orders.createRecharge(5000, "recharge-key");
    await client.orders.createMachine(
      { name: "paid-dev", planId: "p1", imageId: "img1" },
      "machine-key",
    );
    await client.orders.pay("o/1", { method: "wechat", scene: "native" }, "payment-key");
    await client.orders.sync("o/1", "sync-key");
    await client.orders.close("o/1", "close-key");
    await client.machines.getSubscription("m/1");
    await client.machines.updateSubscription("m/1", false);

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "http://api.test/api/v1/account/wallet"],
      ["POST", "http://api.test/api/v1/recharge-orders"],
      ["POST", "http://api.test/api/v1/machine-orders"],
      ["POST", "http://api.test/api/v1/orders/o%2F1/payments"],
      ["POST", "http://api.test/api/v1/orders/o%2F1/sync"],
      ["POST", "http://api.test/api/v1/orders/o%2F1/close"],
      ["GET", "http://api.test/api/v1/machines/m%2F1/subscription"],
      ["PATCH", "http://api.test/api/v1/machines/m%2F1/subscription"],
    ]);
    expect(calls[1]!.headers["idempotency-key"]).toBe("recharge-key");
    expect(calls[1]!.body).toEqual({ amountCents: 5000 });
    expect(calls[2]!.headers["idempotency-key"]).toBe("machine-key");
    expect(calls[3]!.headers["idempotency-key"]).toBe("payment-key");
    expect(calls[3]!.body).toEqual({ method: "wechat", scene: "native" });
    expect(calls[7]!.body).toEqual({ autoRenew: false });
  });

  test("试用资格与领取方法使用账户路径并传递幂等键", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, {}));
    const { client } = createClient(fetchImpl);

    await client.account.getTrial();
    await client.account.claimTrial(
      { name: "trial-dev", planId: "p/1", imageId: "ubuntu-24.04" },
      "trial-claim-key",
    );

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "http://api.test/api/v1/account/trial"],
      ["POST", "http://api.test/api/v1/account/trial/claim"],
    ]);
    expect(calls[1]!.headers["idempotency-key"]).toBe("trial-claim-key");
    expect(calls[1]!.body).toEqual({
      name: "trial-dev",
      planId: "p/1",
      imageId: "ubuntu-24.04",
    });
  });

  test("订单和余额分页同时传递时间与 ID 游标", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse(200, { orders: [], transactions: [], nextBefore: null, nextBeforeId: null }),
    );
    const { client } = createClient(fetchImpl);
    const before = "2026-09-10T10:00:00.000Z";

    await client.orders.list({ limit: 20, before, beforeId: "order-20" });
    await client.account.getWalletTransactions({ limit: 10, before, beforeId: "tx-10" });

    expect(calls[0]!.url).toBe(
      `http://api.test/api/v1/orders?limit=20&before=${encodeURIComponent(before)}&beforeId=order-20`,
    );
    expect(calls[1]!.url).toBe(
      `http://api.test/api/v1/account/wallet/transactions?limit=10&before=${encodeURIComponent(before)}&beforeId=tx-10`,
    );
  });

  test("未登录（无 token）不带 authorization 头", async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse(200, {}));
    const { client } = createClient(fetchImpl, null);
    await client.auth.me().catch(() => {});
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });
});

describe("错误映射", () => {
  test("服务端错误体映射为 ApiError(code/message/status)", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse(409, { error: { code: "STATE_CONFLICT", message: "cannot start" } }),
    );
    const { client } = createClient(fetchImpl);
    const err = await client.machines.start("m1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("STATE_CONFLICT");
    expect((err as ApiError).message).toBe("cannot start");
  });

  test("非 JSON 错误体回退为 REQUEST_ERROR", async () => {
    const { fetchImpl } = mockFetch(
      () => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }),
    );
    const { client } = createClient(fetchImpl);
    const err = (await client.auth.me().catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("REQUEST_ERROR");
    expect(err.status).toBe(502);
  });

  test("204 返回 undefined（logout）", async () => {
    const { fetchImpl } = mockFetch(() => new Response(null, { status: 204 }));
    const { client } = createClient(fetchImpl);
    expect(await client.auth.logout()).toBeUndefined();
  });
});

describe("401 refresh 重试", () => {
  test("two clients dispatch refresh only after obtaining their shared cookie lock", async () => {
    let tail = Promise.resolve();
    const withAuthLock: NonNullable<ApiClientOptions["withAuthLock"]> = (operation) => {
      const result = tail.then(operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    let sharedCookie = "cookie-0";
    const consumed: string[] = [];
    const { fetchImpl } = mockFetch(async () => {
      const cookie = sharedCookie;
      if (consumed.includes(cookie))
        return jsonResponse(401, { error: { code: "REPLAY", message: "replay" } });
      consumed.push(cookie);
      await Bun.sleep(10);
      sharedCookie = `cookie-${consumed.length}`;
      return jsonResponse(200, { accessToken: `access-${consumed.length}` });
    });
    const first = createClient(fetchImpl, null, withAuthLock);
    const second = createClient(fetchImpl, null, withAuthLock);
    expect(await Promise.all([first.client.auth.refresh(), second.client.auth.refresh()])).toEqual([
      "access-1",
      "access-2",
    ]);
    expect(consumed).toEqual(["cookie-0", "cookie-1"]);
    expect(first.getToken()).toBe("access-1");
    expect(second.getToken()).toBe("access-2");
  });

  test("authentication cookie mutations use the injected lock, other requests do not", async () => {
    let locked = false;
    const paths: string[] = [];
    const withAuthLock: NonNullable<ApiClientOptions["withAuthLock"]> = async (operation) => {
      locked = true;
      try {
        return await operation();
      } finally {
        locked = false;
      }
    };
    const { fetchImpl } = mockFetch((call) => {
      const path = new URL(call.url).pathname;
      if (
        [
          "/api/v1/auth/refresh",
          "/api/v1/auth/login",
          "/api/v1/auth/register",
          "/api/v1/auth/logout",
        ].includes(path)
      ) {
        expect(locked).toBe(true);
        paths.push(path);
      } else expect(locked).toBe(false);
      return path.endsWith("logout")
        ? new Response(null, { status: 204 })
        : jsonResponse(200, { accessToken: "new-token" });
    });
    const { client } = createClient(fetchImpl, null, withAuthLock);
    await client.auth.refresh();
    await client.auth.login({ email: "user@example.test", password: "password-123" });
    await client.auth.register({
      email: "user@example.test",
      password: "password-123",
      displayName: "User",
      verificationCode: "123456",
    });
    await client.auth.logout();
    await client.auth.sendRegistrationCode({ email: "user@example.test" });
    await client.plans.list();
    expect(paths).toHaveLength(4);
  });

  test("failed refresh releases the shared lock and single-client refresh still deduplicates", async () => {
    let tail = Promise.resolve();
    const withAuthLock: NonNullable<ApiClientOptions["withAuthLock"]> = (operation) => {
      const result = tail.then(operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    const { calls, fetchImpl } = mockFetch(async (_call, index) => {
      await Bun.sleep(10);
      return index === 0
        ? jsonResponse(503, { error: { code: "TEMPORARY", message: "temporary" } })
        : jsonResponse(200, { accessToken: "recovered" });
    });
    const first = createClient(fetchImpl, "existing", withAuthLock);
    const second = createClient(fetchImpl, null, withAuthLock);
    const results = await Promise.allSettled([
      first.client.auth.refresh(),
      first.client.auth.refresh(),
      second.client.auth.refresh(),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "fulfilled"]);
    expect(calls).toHaveLength(2);
    expect(first.getToken()).toBe("existing");
    expect(second.getToken()).toBe("recovered");
  });
  test("401 → POST /auth/refresh → 用新 token 重放一次", async () => {
    const { calls, fetchImpl } = mockFetch((call, i) => {
      if (i === 0) return jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "x" } });
      if (call.url.endsWith("/api/v1/auth/refresh")) {
        return jsonResponse(200, { accessToken: "token-2" });
      }
      return jsonResponse(200, { id: "u1", email: "a@b.c", displayName: "A", status: "active" });
    });
    const { client, getToken } = createClient(fetchImpl);

    const me = await client.auth.me();
    expect(me.id).toBe("u1");
    expect(getToken()).toBe("token-2");
    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toBe("http://api.test/api/v1/auth/refresh");
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.headers["x-requested-with"]).toBe("fetch");
    expect(calls[2]!.headers.authorization).toBe("Bearer token-2");
  });

  test("并发 401 共享同一次 refresh（rotate 防竞态）", async () => {
    const { calls, fetchImpl } = mockFetch(async (call) => {
      if (call.url.endsWith("/api/v1/auth/refresh")) {
        await Bun.sleep(20);
        return jsonResponse(200, { accessToken: "token-2" });
      }
      if (call.headers.authorization === "Bearer token-1") {
        return jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "x" } });
      }
      return jsonResponse(200, []);
    });
    const { client } = createClient(fetchImpl);

    const [a, b] = await Promise.all([client.machines.list(), client.plans.list()]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    const refreshCalls = calls.filter((c) => c.url.endsWith("/api/v1/auth/refresh"));
    expect(refreshCalls).toHaveLength(1);
  });

  test("refresh 失败 → 清 token + onSessionExpired + 抛错", async () => {
    const { fetchImpl } = mockFetch((call) => {
      if (call.url.endsWith("/api/v1/auth/refresh")) {
        return jsonResponse(401, {
          error: { code: "INVALID_REFRESH_TOKEN", message: "expired" },
        });
      }
      return jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "x" } });
    });
    const { client, getToken, expired } = createClient(fetchImpl);
    const err = (await client.auth.me().catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("INVALID_REFRESH_TOKEN");
    expect(getToken()).toBeNull();
    expect(expired).toEqual(["expired"]);
  });

  test("refresh 返回 403 → 同样视为会话失效，清 token + onSessionExpired", async () => {
    const { fetchImpl } = mockFetch((call) => {
      if (call.url.endsWith("/api/v1/auth/refresh")) {
        return jsonResponse(403, { error: { code: "FORBIDDEN", message: "revoked" } });
      }
      return jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "x" } });
    });
    const { client, getToken, expired } = createClient(fetchImpl);
    const err = (await client.auth.me().catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(403);
    expect(getToken()).toBeNull();
    expect(expired).toEqual(["expired"]);
  });

  test("refresh 返回 5xx → 保留会话，不清 token、不触发 onSessionExpired", async () => {
    const { fetchImpl } = mockFetch((call) => {
      if (call.url.endsWith("/api/v1/auth/refresh")) {
        return jsonResponse(500, { error: { code: "INTERNAL", message: "boom" } });
      }
      return jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "x" } });
    });
    const { client, getToken, expired } = createClient(fetchImpl);
    const err = (await client.auth.me().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(getToken()).toBe("token-1");
    expect(expired).toEqual([]);
  });

  test("refresh 网络层失败（fetch reject）→ 保留会话，错误原样向上抛", async () => {
    const networkErr = new TypeError("fetch failed: DNS");
    const { fetchImpl } = mockFetch((call) => {
      if (call.url.endsWith("/api/v1/auth/refresh")) throw networkErr;
      return jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "x" } });
    });
    const { client, getToken, expired } = createClient(fetchImpl);
    const err = await client.auth.me().catch((e: unknown) => e);
    expect(err).toBe(networkErr);
    expect(getToken()).toBe("token-1");
    expect(expired).toEqual([]);
  });

  test("login 自身 401 不触发 refresh", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse(401, { error: { code: "INVALID_CREDENTIALS", message: "invalid" } }),
    );
    const { client } = createClient(fetchImpl, null);
    const err = (await client.auth
      .login({ email: "a@b.c", password: "wrong-pass" })
      .catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("INVALID_CREDENTIALS");
    expect(calls).toHaveLength(1);
  });
});

describe("Desktop refresh token adapter", () => {
  function desktopClient(fetchImpl: typeof fetch) {
    let accessToken: string | null = "access-1";
    let refreshToken: string | null = "refresh-1";
    const client = createApiClient({
      baseUrl: "http://api.test",
      getAccessToken: () => accessToken,
      setAccessToken: (value) => {
        accessToken = value;
      },
      getDesktopRefreshToken: () => refreshToken,
      setDesktopRefreshToken: (value) => {
        refreshToken = value;
      },
      fetchImpl,
    });
    return {
      client,
      tokens: () => ({ accessToken, refreshToken }),
    };
  }

  test("401 uses body-based Desktop refresh, rotates both tokens, then replays", async () => {
    const { calls, fetchImpl } = mockFetch((call) => {
      if (call.url.endsWith("/auth/desktop/refresh")) {
        return jsonResponse(200, {
          accessToken: "access-2",
          refreshToken: "refresh-2",
          tokenType: "Bearer",
          expiresInSeconds: 900,
        });
      }
      if (call.headers.authorization === "Bearer access-1") {
        return jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "expired" } });
      }
      return jsonResponse(200, { id: "u1", email: "a@b.c", displayName: "A", status: "active" });
    });
    const { client, tokens } = desktopClient(fetchImpl);

    expect((await client.auth.me()).id).toBe("u1");
    expect(tokens()).toEqual({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(calls[1]).toMatchObject({
      url: "http://api.test/api/v1/auth/desktop/refresh",
      body: { refreshToken: "refresh-1" },
    });
    expect(calls[1]!.headers.authorization).toBeUndefined();
    expect(calls[1]!.credentials).toBe("omit");
    expect(calls[2]!.headers.authorization).toBe("Bearer access-2");
  });

  test("exchange stores response tokens and revoke clears them", async () => {
    const { calls, fetchImpl } = mockFetch((call) => {
      if (call.url.endsWith("/auth/desktop/token")) {
        return jsonResponse(200, {
          accessToken: "access-exchanged",
          refreshToken: "refresh-exchanged",
          tokenType: "Bearer",
          expiresInSeconds: 900,
        });
      }
      return new Response(null, { status: 204 });
    });
    const { client, tokens } = desktopClient(fetchImpl);
    await client.desktopAuth.exchangeAuthorizationCode({
      grantType: "authorization_code",
      clientId: "renrencodex-desktop",
      redirectUri: "renrencodex://oauth/callback",
      authorizationCode: "A".repeat(43),
      codeVerifier: "v".repeat(43),
    });
    expect(tokens()).toEqual({
      accessToken: "access-exchanged",
      refreshToken: "refresh-exchanged",
    });
    expect(calls[0]!.headers.authorization).toBeUndefined();

    await client.desktopAuth.revoke();
    expect(calls[1]).toMatchObject({
      url: "http://api.test/api/v1/auth/desktop/revoke",
      body: { refreshToken: "refresh-exchanged" },
    });
    expect(tokens()).toEqual({ accessToken: null, refreshToken: null });
  });

  test("requires Desktop refresh token getter/setter as a pair", () => {
    expect(() =>
      createApiClient({
        baseUrl: "",
        getAccessToken: () => null,
        setAccessToken: () => undefined,
        getDesktopRefreshToken: () => null,
      }),
    ).toThrow("getter and setter");
  });

  test("exchange does not resolve before the rotated refresh token is durably stored", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse(200, {
        accessToken: "access-new",
        refreshToken: "refresh-new",
        tokenType: "Bearer",
        expiresInSeconds: 900,
      }),
    );
    let accessToken: string | null = null;
    let releaseStorage!: () => void;
    const storage = new Promise<void>((resolve) => {
      releaseStorage = resolve;
    });
    const client = createApiClient({
      baseUrl: "http://api.test",
      getAccessToken: () => accessToken,
      setAccessToken: (value) => {
        accessToken = value;
      },
      getDesktopRefreshToken: () => null,
      setDesktopRefreshToken: () => storage,
      fetchImpl,
    });
    let settled = false;
    const exchange = client.desktopAuth
      .exchangeAuthorizationCode({
        grantType: "authorization_code",
        clientId: "renrencodex-desktop",
        redirectUri: "renrencodex://oauth/callback",
        authorizationCode: "A".repeat(43),
        codeVerifier: "v".repeat(43),
      })
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(accessToken).toBeNull();
    releaseStorage();
    await exchange;
    expect(accessToken as string | null).toBe("access-new");
  });

  test("refresh and revoke await asynchronous secure storage writes", async () => {
    const { fetchImpl } = mockFetch((call) =>
      call.url.endsWith("/refresh")
        ? jsonResponse(200, {
            accessToken: "access-2",
            refreshToken: "refresh-2",
            tokenType: "Bearer",
            expiresInSeconds: 900,
          })
        : new Response(null, { status: 204 }),
    );
    let refreshToken: string | null = "refresh-1";
    const writes: Array<string | null> = [];
    const client = createApiClient({
      baseUrl: "http://api.test",
      getAccessToken: () => "access-1",
      setAccessToken: () => undefined,
      getDesktopRefreshToken: () => refreshToken,
      setDesktopRefreshToken: async (value) => {
        await Promise.resolve();
        writes.push(value);
        refreshToken = value;
      },
      fetchImpl,
    });
    await client.desktopAuth.refresh();
    expect(writes).toEqual(["refresh-2"]);
    await client.desktopAuth.revoke();
    expect(writes).toEqual(["refresh-2", null]);
    expect(refreshToken).toBeNull();
  });

  test("an explicitly rejected Desktop refresh clears durable state before expiry notification", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse(401, { error: { code: "SESSION_REVOKED", message: "revoked" } }),
    );
    const events: string[] = [];
    const client = createApiClient({
      baseUrl: "http://api.test",
      getAccessToken: () => "access-1",
      setAccessToken: (value) => events.push(`access:${value}`),
      getDesktopRefreshToken: () => "refresh-1",
      setDesktopRefreshToken: async (value) => {
        await Promise.resolve();
        events.push(`refresh:${value}`);
      },
      onSessionExpired: () => events.push("expired"),
      fetchImpl,
    });
    await expect(client.desktopAuth.refresh()).rejects.toBeInstanceOf(ApiError);
    expect(events).toEqual(["access:null", "refresh:null", "expired"]);
  });

  for (const status of [401, 403]) {
    test(`Desktop refresh ${status} still notifies expiry when secure storage cleanup rejects`, async () => {
      const { fetchImpl } = mockFetch(() =>
        jsonResponse(status, {
          error: { code: "SESSION_REVOKED", message: "refresh rejected" },
        }),
      );
      const cleanupError = new Error("secure storage unavailable");
      let accessToken: string | null = "access-1";
      const events: string[] = [];
      const client = createApiClient({
        baseUrl: "http://api.test",
        getAccessToken: () => accessToken,
        setAccessToken: (value) => {
          accessToken = value;
          events.push(`access:${value}`);
        },
        getDesktopRefreshToken: () => "refresh-1",
        setDesktopRefreshToken: (value) => {
          events.push(`refresh:${value}`);
          if (value === null) throw cleanupError;
        },
        onSessionExpired: () => events.push("expired"),
        fetchImpl,
      });

      const error = await client.desktopAuth.refresh().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status, code: "SESSION_REVOKED" });
      expect(error).not.toBe(cleanupError);
      expect(accessToken).toBeNull();
      expect(events).toEqual(["access:null", "refresh:null", "expired"]);
    });
  }
});

describe("Android email session adapter", () => {
  function mobileClient(fetchImpl: typeof fetch) {
    let accessToken: string | null = null;
    let refreshToken: string | null = null;
    const client = createApiClient({
      baseUrl: "http://api.test",
      getAccessToken: () => accessToken,
      setAccessToken: (value) => {
        accessToken = value;
      },
      nativeSession: {
        kind: "mobile",
        getRefreshToken: () => refreshToken,
        setRefreshToken: (value) => {
          refreshToken = value;
        },
      },
      fetchImpl,
    });
    return { client, tokens: () => ({ accessToken, refreshToken }) };
  }

  test("邮箱密码登录不使用 Desktop PKCE，并持久化 Android 会话", async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse(200, {
        accessToken: "mobile-access-1",
        refreshToken: "mobile-refresh-1",
        tokenType: "Bearer",
        expiresInSeconds: 900,
        user: {
          id: "user-1",
          email: "user@example.com",
          displayName: "User",
          status: "active",
          referralEnabled: false,
          referralProgramExists: false,
        },
      }),
    );
    const { client, tokens } = mobileClient(fetchImpl);

    await client.mobileAuth.login({
      email: "user@example.com",
      password: "password-123",
      deviceName: "人人Codex Android",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://api.test/api/v1/auth/mobile/login",
      method: "POST",
      credentials: "omit",
      body: {
        email: "user@example.com",
        password: "password-123",
        deviceName: "人人Codex Android",
      },
    });
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(tokens()).toEqual({
      accessToken: "mobile-access-1",
      refreshToken: "mobile-refresh-1",
    });
  });

  test("注册、轮换和退出均使用 mobile 端点", async () => {
    const { calls, fetchImpl } = mockFetch((call) => {
      if (call.url.endsWith("/mobile/register")) {
        return jsonResponse(201, {
          accessToken: "mobile-access-1",
          refreshToken: "mobile-refresh-1",
          tokenType: "Bearer",
          expiresInSeconds: 900,
        });
      }
      if (call.url.endsWith("/mobile/refresh")) {
        return jsonResponse(200, {
          accessToken: "mobile-access-2",
          refreshToken: "mobile-refresh-2",
          tokenType: "Bearer",
          expiresInSeconds: 900,
        });
      }
      return new Response(null, { status: 204 });
    });
    const { client, tokens } = mobileClient(fetchImpl);

    await client.mobileAuth.register({
      email: "new@example.com",
      password: "password-123",
      displayName: "New User",
      verificationCode: "246810",
      deviceName: "Android phone",
    });
    await client.mobileAuth.refresh();
    await client.mobileAuth.revoke();

    expect(calls.map((call) => call.url)).toEqual([
      "http://api.test/api/v1/auth/mobile/register",
      "http://api.test/api/v1/auth/mobile/refresh",
      "http://api.test/api/v1/auth/mobile/revoke",
    ]);
    expect(calls[1]!.body).toEqual({ refreshToken: "mobile-refresh-1" });
    expect(calls[2]!.body).toEqual({ refreshToken: "mobile-refresh-2" });
    expect(tokens()).toEqual({ accessToken: null, refreshToken: null });
  });

  test("安全存储写入失败时回收刚签发的服务端会话", async () => {
    const storageError = new Error("Android Keystore unavailable");
    const { calls, fetchImpl } = mockFetch((call) =>
      call.url.endsWith("/mobile/login")
        ? jsonResponse(200, {
            accessToken: "mobile-access",
            refreshToken: "orphan-refresh",
            tokenType: "Bearer",
            expiresInSeconds: 900,
          })
        : new Response(null, { status: 204 }),
    );
    let accessToken: string | null = null;
    const client = createApiClient({
      baseUrl: "http://api.test",
      getAccessToken: () => accessToken,
      setAccessToken: (value) => {
        accessToken = value;
      },
      nativeSession: {
        kind: "mobile",
        getRefreshToken: () => null,
        setRefreshToken: (value) => {
          if (value !== null) throw storageError;
        },
      },
      fetchImpl,
    });

    await expect(
      client.mobileAuth.login({
        email: "user@example.com",
        password: "password-123",
        deviceName: "Android phone",
      }),
    ).rejects.toBe(storageError);
    expect(calls[1]).toMatchObject({
      url: "http://api.test/api/v1/auth/mobile/revoke",
      body: { refreshToken: "orphan-refresh" },
    });
    expect(accessToken).toBeNull();
  });
});
