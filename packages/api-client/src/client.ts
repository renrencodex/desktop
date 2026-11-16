/**
 * 基于 fetch 的 /api/v1 TypeScript SDK（设计文档 25 节 API + 57.12 客户端认证）。
 *
 * - access token 只经 getter/setter 注入（客户端内存持有，禁 localStorage）；
 * - 401 → Web 用 HttpOnly Cookie、Desktop 用注入的 Secure Storage token 自动 refresh；
 *   并发请求共享同一次 refresh（去重）；
 * - 变更类请求自动带 x-requested-with: fetch（API CSRF 校验，见 apps/api server.ts）；
 * - 错误统一映射为 ApiError（code/message/status）。
 */
import type {
  CliApp,
  CliOperation,
  CliStoreOperationInput,
  MachineCliInventory,
} from "@cloud-machine/client-contracts";
import { ApiError } from "./error";
import type {
  MachineConnectionChannel,
  MachineConnectionTicket,
  RescueSize,
  RescueSession,
  WorkspaceDiffResult,
  WorkspaceDiffFileResult,
  WorkspaceDiffFileQuery,
} from "@cloud-machine/client-contracts";
import type {
  ApiErrorBody,
  AccountNotification,
  AccountNotificationSummary,
  AccountQuota,
  AccountTrial,
  AccountUsage,
  AuthResponse,
  BillingCapabilities,
  CommerceOrder,
  CommerceOrdersPage,
  CommerceOrderStatus,
  CommerceOrderType,
  CreateMachineInput,
  ClaimTrialInput,
  CreateWorkspaceInput,
  CreateWorkspaceGitImportInput,
  EgressLineOption,
  Machine,
  MachineConnection,
  MachineDeletionQuote,
  MachineEventsPage,
  MachinePort,
  MachinePortShare,
  MachinePortRow,
  MachineProvisioningStatus,
  MachineSnapshot,
  MachineSubscription,
  MarkAllNotificationsReadResponse,
  PaymentResponse,
  Plan,
  PortShare,
  PortVisibility,
  RebuildMachineInput,
  ReferralCommission,
  ReferralDomain,
  ReferralDomainContext,
  ReferralDomainRegistrationResponse,
  ReferralListOptions,
  ReferralOverview,
  ReferralOrder,
  ReferralPage,
  ReferralPayout,
  ReferralPayoutBindingSession,
  ReferralPayoutBindingStatus,
  ReferralSettlement,
  ReferredUser,
  RefreshResponse,
  RegistrationCodeResponse,
  SaveWorkbenchLayoutInput,
  PasswordResetRequestResponse,
  UpdateMachineInput,
  UpdateMachineEgressLineInput,
  UpdateWorkspaceInput,
  User,
  Wallet,
  WalletTransactionsPage,
  WechatPaymentScene,
  WechatJsapiConfig,
  WorkbenchLayoutState,
  Workspace,
  WorkspaceRuntimeStatus,
  WorkspaceGitImportStart,
  WorkspaceGitImportStatus,
} from "./types";
import type { PublicPlanCatalog } from "./public-plans";
import type {
  CreateDesktopAuthorizationCodeInput,
  CreateDesktopAuthorizationCodeResponse,
  DesktopTokenResponse,
  ExchangeDesktopAuthorizationCodeInput,
} from "./desktop-oauth";
import type { MobileLoginInput, MobileRegisterInput, MobileTokenResponse } from "./mobile-auth";

export interface NativeSessionAdapter {
  readonly kind: "desktop" | "mobile";
  getRefreshToken(): string | null;
  setRefreshToken(token: string | null): void | Promise<void>;
}

export interface ApiClientOptions {
  /** 如 "http://localhost:3000" 或 ""（同源，经 Vite proxy）。 */
  baseUrl: string;
  /** access token getter（内存持有）；未登录返回 null。 */
  getAccessToken: () => string | null;
  /** refresh 成功后写回新 access token。 */
  setAccessToken: (token: string | null) => void;
  /** refresh 失败（会话彻底失效）回调，用于跳转登录页。 */
  onSessionExpired?: () => void;
  /** Tauri 原生会话：refresh token 由系统安全存储持有，HTTP 请求不使用 Cookie。 */
  nativeSession?: NativeSessionAdapter;
  /** Desktop Secure Storage 中的 refresh token；与 setter 成对提供时启用 Desktop 流程。 */
  getDesktopRefreshToken?: () => string | null;
  /**
   * Desktop refresh/exchange 轮换后写回 Secure Storage。
   * 原生安全存储通常是异步 IPC；SDK 必须等待持久化完成后才能暴露成功结果。
   */
  setDesktopRefreshToken?: (token: string | null) => void | Promise<void>;
  /** 测试注入用；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 客户端认证 Cookie 互斥锁；Web 注入跨标签页实现，不在 SDK 内依赖 DOM。 */
  withAuthLock?: <T>(operation: () => Promise<T>) => Promise<T>;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** 内部标记：refresh 重放后的第二次尝试，不再重试。 */
  retried?: boolean;
  /** 跳过 401 refresh 逻辑（refresh / login 自身）。 */
  skipAuthRetry?: boolean;
  /** OAuth token/refresh 请求不携带可能已过期的 access token。 */
  omitAccessToken?: boolean;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function referralListPath(
  resource: "users" | "orders" | "commissions" | "settlements" | "payouts",
  opts: ReferralListOptions,
): string {
  const query = new URLSearchParams();
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  if (opts.cursor) query.set("cursor", opts.cursor);
  if (opts.page !== undefined) query.set("page", String(opts.page));
  if (opts.pageSize !== undefined) query.set("pageSize", String(opts.pageSize));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return `/api/v1/account/referrals/${resource}${suffix}`;
}

export function createApiClient(options: ApiClientOptions) {
  if (Boolean(options.getDesktopRefreshToken) !== Boolean(options.setDesktopRefreshToken)) {
    throw new Error("desktop refresh token getter and setter must be provided together");
  }
  const nativeSession: NativeSessionAdapter | undefined =
    options.nativeSession ??
    (options.getDesktopRefreshToken && options.setDesktopRefreshToken
      ? {
          kind: "desktop",
          getRefreshToken: options.getDesktopRefreshToken,
          setRefreshToken: options.setDesktopRefreshToken,
        }
      : undefined);
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const nativeRefreshEnabled = nativeSession !== undefined;
  /** 并发 401 共享同一次 refresh，避免 rotate 竞态（旧 refresh token 立即吊销）。 */
  let refreshInFlight: Promise<string> | null = null;

  async function parseError(res: Response): Promise<ApiError> {
    let code = "REQUEST_ERROR";
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as Partial<ApiErrorBody>;
      if (body.error?.code && body.error?.message) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      // 非 JSON 错误体（如网关 502），保留默认 message。
    }
    return new ApiError(res.status, code, message);
  }

  async function rawRequest<T>(path: string, init: RequestOptions): Promise<T> {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { ...init.headers };
    const token = init.omitAccessToken ? null : options.getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
    // CSRF（57.12）：变更类请求必须带自定义头。
    if (!SAFE_METHODS.has(method)) headers["x-requested-with"] = "fetch";
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body,
      // Web 需要 HttpOnly refresh cookie；Desktop 跨 Origin 只使用响应体 refresh token，
      // 明确 omit，避免 CORS 依赖 Access-Control-Allow-Credentials。
      credentials: nativeRefreshEnabled ? "omit" : "include",
    });
    if (!res.ok) throw await parseError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  function authCookieRequest<T>(path: string, init: RequestOptions): Promise<T> {
    // 必须在持锁期间发送请求：浏览器到此时才读取共享 HttpOnly Cookie。
    const operation = () => rawRequest<T>(path, init);
    return options.withAuthLock ? options.withAuthLock(operation) : operation();
  }

  async function refreshAccessToken(): Promise<string> {
    const operation: () => Promise<RefreshResponse | DesktopTokenResponse | MobileTokenResponse> =
      nativeRefreshEnabled
        ? () => {
            const refreshToken = nativeSession.getRefreshToken();
            if (!refreshToken) {
              throw new ApiError(401, "NO_REFRESH_TOKEN", "native refresh token missing");
            }
            return rawRequest<DesktopTokenResponse | MobileTokenResponse>(
              `/api/v1/auth/${nativeSession.kind}/refresh`,
              {
                method: "POST",
                body: { refreshToken },
                skipAuthRetry: true,
                omitAccessToken: true,
              },
            );
          }
        : () =>
            authCookieRequest<RefreshResponse>("/api/v1/auth/refresh", {
              method: "POST",
              skipAuthRetry: true,
            });
    refreshInFlight ??= operation()
      .then(async (r) => {
        options.setAccessToken(r.accessToken);
        if ("refreshToken" in r) {
          try {
            await nativeSession!.setRefreshToken(r.refreshToken);
          } catch (error) {
            // 不得继续使用尚未可靠持久化的新 access token；旧 refresh token 已被轮换。
            options.setAccessToken(null);
            await discardUnpersistedNativeSession(r.refreshToken);
            throw error;
          }
        }
        return r.accessToken;
      })
      .catch(async (error: unknown) => {
        // 显式 refresh（启动恢复、Gateway 建连）与 401 自动重试必须使用同一失效语义。
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          options.setAccessToken(null);
          try {
            await nativeSession?.setRefreshToken(null);
          } catch {
            // Secure Storage 清理失败不能阻止过期通知，也不能覆盖服务端认证错误。
          }
          try {
            options.onSessionExpired?.();
          } catch {
            // 回调失败同样不能覆盖可判定的认证错误。
          }
        }
        throw error;
      })
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  }

  async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    try {
      return await rawRequest<T>(path, init);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 401 &&
        !init.retried &&
        !init.skipAuthRetry &&
        options.getAccessToken() !== null
      ) {
        // 明确拒绝会统一清理会话；临时网络错误保留会话并原样抛出。
        await refreshAccessToken();
        return rawRequest<T>(path, { ...init, retried: true });
      }
      throw err;
    }
  }

  async function revokeNativeSession(expectedKind?: NativeSessionAdapter["kind"]): Promise<void> {
    if (!nativeSession || (expectedKind && nativeSession.kind !== expectedKind)) {
      throw new Error(`${expectedKind ?? "native"} refresh token storage is not configured`);
    }
    const refreshToken = nativeSession.getRefreshToken();
    try {
      if (refreshToken) {
        await rawRequest<void>(`/api/v1/auth/${nativeSession.kind}/revoke`, {
          method: "POST",
          body: { refreshToken },
          skipAuthRetry: true,
          omitAccessToken: true,
        });
      }
    } finally {
      options.setAccessToken(null);
      await nativeSession.setRefreshToken(null);
    }
  }

  async function discardUnpersistedNativeSession(refreshToken: string): Promise<void> {
    if (!nativeSession) return;
    try {
      await rawRequest<void>(`/api/v1/auth/${nativeSession.kind}/revoke`, {
        method: "POST",
        body: { refreshToken },
        skipAuthRetry: true,
        omitAccessToken: true,
      });
    } catch {
      // 服务端回收失败时不覆盖安全存储的原始错误；会话仍受固定有效期约束。
    }
    try {
      await nativeSession.setRefreshToken(null);
    } catch {
      // 原始持久化错误更有诊断价值。
    }
  }

  async function acceptNativeTokens<T extends DesktopTokenResponse | MobileTokenResponse>(
    response: T,
    expectedKind: NativeSessionAdapter["kind"],
  ): Promise<T> {
    if (!nativeSession || nativeSession.kind !== expectedKind) {
      throw new Error(`${expectedKind} refresh token storage is not configured`);
    }
    try {
      await nativeSession.setRefreshToken(response.refreshToken);
    } catch (error) {
      options.setAccessToken(null);
      await discardUnpersistedNativeSession(response.refreshToken);
      throw error;
    }
    options.setAccessToken(response.accessToken);
    return response;
  }

  return {
    auth: {
      requestPasswordReset: (input: { email: string }) =>
        request<PasswordResetRequestResponse>("/api/v1/auth/password-reset-requests", {
          method: "POST",
          body: input,
          skipAuthRetry: true,
        }),
      resetPassword: (input: { token: string; newPassword: string }) =>
        authCookieRequest<void>("/api/v1/auth/password-reset", {
          method: "POST",
          body: input,
          skipAuthRetry: true,
        }),
      sendRegistrationCode: (input: { email: string }) =>
        request<RegistrationCodeResponse>("/api/v1/auth/registration-code", {
          method: "POST",
          body: input,
          skipAuthRetry: true,
        }),
      referralDomainContext: () =>
        request<ReferralDomainContext>("/api/v1/referral-domain/context", {
          skipAuthRetry: true,
        }),
      registerFromReferralDomain: (
        input: {
          email: string;
          verificationCode: string;
          password: string;
          displayName: string;
        },
        idempotencyKey: string,
      ) =>
        request<ReferralDomainRegistrationResponse>("/api/v1/auth/referral-domain/register", {
          method: "POST",
          body: input,
          headers: { "idempotency-key": idempotencyKey },
          skipAuthRetry: true,
        }),
      completeReferralDomainHandoff: (token: string, idempotencyKey?: string) =>
        authCookieRequest<AuthResponse>("/api/v1/auth/referral-domain/handoff", {
          method: "POST",
          body: { token },
          headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
          skipAuthRetry: true,
        }),
      register: (input: {
        email: string;
        verificationCode: string;
        password: string;
        displayName: string;
      }) =>
        authCookieRequest<AuthResponse>("/api/v1/auth/register", {
          method: "POST",
          body: input,
          skipAuthRetry: true,
        }),
      login: (input: { email: string; password: string }) =>
        authCookieRequest<AuthResponse>("/api/v1/auth/login", {
          method: "POST",
          body: input,
          skipAuthRetry: true,
        }),
      refresh: () => refreshAccessToken(),
      logout: async () => {
        if (!nativeRefreshEnabled) {
          return authCookieRequest<void>("/api/v1/auth/logout", {
            method: "POST",
            skipAuthRetry: true,
          });
        }
        return revokeNativeSession();
      },
      me: () => request<User>("/api/v1/auth/me"),
    },
    desktopAuth: {
      createAuthorizationCode: (input: CreateDesktopAuthorizationCodeInput) =>
        request<CreateDesktopAuthorizationCodeResponse>(
          "/api/v1/auth/desktop/authorization-codes",
          { method: "POST", body: input },
        ),
      exchangeAuthorizationCode: async (input: ExchangeDesktopAuthorizationCodeInput) => {
        const response = await rawRequest<DesktopTokenResponse>("/api/v1/auth/desktop/token", {
          method: "POST",
          body: input,
          skipAuthRetry: true,
          omitAccessToken: true,
        });
        return acceptNativeTokens(response, "desktop");
      },
      refresh: () => refreshAccessToken(),
      revoke: () => revokeNativeSession("desktop"),
    },
    mobileAuth: {
      login: async (input: MobileLoginInput) => {
        const response = await rawRequest<MobileTokenResponse>("/api/v1/auth/mobile/login", {
          method: "POST",
          body: input,
          skipAuthRetry: true,
          omitAccessToken: true,
        });
        return acceptNativeTokens(response, "mobile");
      },
      register: async (input: MobileRegisterInput) => {
        const response = await rawRequest<MobileTokenResponse>("/api/v1/auth/mobile/register", {
          method: "POST",
          body: input,
          skipAuthRetry: true,
          omitAccessToken: true,
        });
        return acceptNativeTokens(response, "mobile");
      },
      refresh: () => refreshAccessToken(),
      revoke: () => revokeNativeSession("mobile"),
    },
    account: {
      getQuota: () => request<AccountQuota>("/api/v1/account/quota"),
      getBillingCapabilities: () =>
        request<BillingCapabilities>("/api/v1/account/billing-capabilities"),
      getTrial: () => request<AccountTrial>("/api/v1/account/trial"),
      claimTrial: (input: ClaimTrialInput, idempotencyKey: string) =>
        request<Machine>("/api/v1/account/trial/claim", {
          method: "POST",
          body: input,
          headers: { "idempotency-key": idempotencyKey },
        }),
      getWallet: () => request<Wallet>("/api/v1/account/wallet"),
      getWalletTransactions: (
        opts: { limit?: number; before?: string; beforeId?: string } = {},
      ) => {
        const qs = new URLSearchParams();
        if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
        if (opts.before) qs.set("before", opts.before);
        if (opts.beforeId) qs.set("beforeId", opts.beforeId);
        const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
        return request<WalletTransactionsPage>(`/api/v1/account/wallet/transactions${suffix}`);
      },
      getNotifications: () => request<AccountNotification[]>("/api/v1/account/notifications"),
      getNotificationSummary: (limit = 6) =>
        request<AccountNotificationSummary>(
          `/api/v1/account/notifications/summary?limit=${encodeURIComponent(String(limit))}`,
        ),
      markNotificationRead: (id: string) =>
        request<void>(`/api/v1/account/notifications/${encodeURIComponent(id)}/read`, {
          method: "POST",
        }),
      markAllNotificationsRead: () =>
        request<MarkAllNotificationsReadResponse>("/api/v1/account/notifications/read-all", {
          method: "POST",
        }),
      getUsage: (opts: { from?: string; to?: string } = {}) => {
        const qs = new URLSearchParams();
        if (opts.from !== undefined) qs.set("from", opts.from);
        if (opts.to !== undefined) qs.set("to", opts.to);
        const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
        return request<AccountUsage>(`/api/v1/account/usage${suffix}`);
      },
      referrals: {
        overview: () => request<ReferralOverview>("/api/v1/account/referrals/overview"),
        updateDomain: (label: string, idempotencyKey: string) =>
          request<ReferralDomain>("/api/v1/account/referrals/domain", {
            method: "PUT",
            body: { label },
            headers: { "idempotency-key": idempotencyKey },
          }),
        updatePageTheme: (themeId: import("./types").ReferralPageThemeId, idempotencyKey: string) =>
          request<{ themeId: import("./types").ReferralPageThemeId }>(
            "/api/v1/account/referrals/page-theme",
            {
              method: "PUT",
              body: { themeId },
              headers: { "idempotency-key": idempotencyKey },
            },
          ),
        updateSalePrice: (
          planId: string,
          salePriceCents: number | null,
          idempotencyKey: string,
          billingPeriod: import("./types").BillingPeriod = "monthly",
        ) =>
          request<ReferralOverview["rates"][number]>(
            `/api/v1/account/referrals/prices/${encodeURIComponent(planId)}`,
            {
              method: "PUT",
              body: { billingPeriod, salePriceCents },
              headers: { "idempotency-key": idempotencyKey },
            },
          ),
        bankAccount: () => request<BankAccountResponse>("/api/v1/account/referrals/bank-account"),
        saveBankAccount: (input: SaveBankAccountInput, idempotencyKey: string) =>
          request<BankAccountView>("/api/v1/account/referrals/bank-account/save", {
            method: "POST",
            body: input,
            headers: { "idempotency-key": idempotencyKey },
          }),
        disableBankAccount: (
          input: { currentPassword: string; expectedVersion: number },
          idempotencyKey: string,
        ) =>
          request<BankAccountView>("/api/v1/account/referrals/bank-account/disable", {
            method: "POST",
            body: input,
            headers: { "idempotency-key": idempotencyKey },
          }),
        users: (opts: ReferralListOptions = {}) =>
          request<ReferralPage<ReferredUser>>(referralListPath("users", opts)),
        commissions: (opts: ReferralListOptions = {}) =>
          request<ReferralPage<ReferralCommission>>(referralListPath("commissions", opts)),
        orders: (opts: ReferralListOptions = {}) =>
          request<ReferralPage<ReferralOrder>>(referralListPath("orders", opts)),
        settlements: (opts: ReferralListOptions = {}) =>
          request<ReferralPage<ReferralSettlement>>(referralListPath("settlements", opts)),
        payouts: (opts: ReferralListOptions = {}) =>
          request<ReferralPage<ReferralPayout>>(referralListPath("payouts", opts)),
        createPayoutBindingSession: (idempotencyKey: string) =>
          request<ReferralPayoutBindingSession>(
            "/api/v1/account/referrals/payout-binding-sessions",
            { method: "POST", headers: { "idempotency-key": idempotencyKey } },
          ),
        getPayoutBindingSession: (id: string, token?: string) => {
          const query = token ? `?token=${encodeURIComponent(token)}` : "";
          return request<ReferralPayoutBindingStatus>(
            `/api/v1/account/referrals/payout-binding-sessions/${encodeURIComponent(id)}${query}`,
          );
        },
        authorizePayoutBinding: (id: string, token: string, recipientName: string) =>
          request<{ authorizeUrl: string }>(
            `/api/v1/account/referrals/payout-binding-sessions/${encodeURIComponent(id)}/authorize`,
            { method: "POST", body: { token, recipientName } },
          ),
        getWechatJsapiConfig: (url: string) =>
          request<WechatJsapiConfig>(
            `/api/v1/account/referrals/wechat-jsapi-config?url=${encodeURIComponent(url)}`,
          ),
        closeWechatAuthorization: (authorizationId: string, idempotencyKey: string) =>
          request<{ accepted: true }>(
            `/api/v1/account/referrals/wechat-authorizations/${encodeURIComponent(authorizationId)}/close`,
            { method: "POST", headers: { "idempotency-key": idempotencyKey } },
          ),
      },
    },
    orders: {
      list: (
        opts: {
          limit?: number;
          before?: string;
          beforeId?: string;
          type?: CommerceOrderType;
          status?: CommerceOrderStatus;
        } = {},
      ) => {
        const qs = new URLSearchParams();
        if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
        if (opts.before) qs.set("before", opts.before);
        if (opts.beforeId) qs.set("beforeId", opts.beforeId);
        if (opts.type) qs.set("type", opts.type);
        if (opts.status) qs.set("status", opts.status);
        const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
        return request<CommerceOrdersPage>(`/api/v1/orders${suffix}`);
      },
      get: (id: string) => request<CommerceOrder>(`/api/v1/orders/${encodeURIComponent(id)}`),
      createRecharge: (amountCents: number, idempotencyKey: string) =>
        request<CommerceOrder>("/api/v1/recharge-orders", {
          method: "POST",
          body: { amountCents },
          headers: { "idempotency-key": idempotencyKey },
        }),
      createMachine: (input: CreateMachineInput, idempotencyKey: string) =>
        request<CommerceOrder>("/api/v1/machine-orders", {
          method: "POST",
          body: input,
          headers: { "idempotency-key": idempotencyKey },
        }),
      createRenewal: (
        machineId: string,
        idempotencyKey: string,
        billingPeriod?: import("./types").BillingPeriod,
      ) =>
        request<CommerceOrder>(`/api/v1/machines/${encodeURIComponent(machineId)}/renewal-orders`, {
          method: "POST",
          body: billingPeriod ? { billingPeriod } : {},
          headers: { "idempotency-key": idempotencyKey },
        }),
      pay: (
        id: string,
        input: { method: "balance" | "wechat"; scene?: WechatPaymentScene },
        idempotencyKey: string,
      ) =>
        request<PaymentResponse>(`/api/v1/orders/${encodeURIComponent(id)}/payments`, {
          method: "POST",
          body: input,
          headers: { "idempotency-key": idempotencyKey },
        }),
      sync: (id: string, idempotencyKey: string) =>
        request<CommerceOrder>(`/api/v1/orders/${encodeURIComponent(id)}/sync`, {
          method: "POST",
          headers: { "idempotency-key": idempotencyKey },
        }),
      close: (id: string, idempotencyKey: string) =>
        request<CommerceOrder>(`/api/v1/orders/${encodeURIComponent(id)}/close`, {
          method: "POST",
          headers: { "idempotency-key": idempotencyKey },
        }),
    },
    machineImages: {
      list: (planId?: string) =>
        request<import("@cloud-machine/client-contracts").MachineImage[]>(
          `/api/v1/machine-images${planId ? `?planId=${encodeURIComponent(planId)}` : ""}`,
        ),
    },
    machines: {
      listEgressLines: () => request<EgressLineOption[]>("/api/v1/egress-lines"),
      createRescueSession: (id: string, size: RescueSize, idempotencyKey: string) =>
        request<RescueSession>(`/api/v1/machines/${encodeURIComponent(id)}/rescue-sessions`, {
          method: "POST",
          body: size,
          headers: { "idempotency-key": idempotencyKey },
        }),
      closeRescueSession: (id: string, sessionId: string) =>
        request<void>(
          `/api/v1/machines/${encodeURIComponent(id)}/rescue-sessions/${encodeURIComponent(sessionId)}`,
          { method: "DELETE" },
        ),
      list: () => request<Machine[]>("/api/v1/machines"),
      get: (id: string) => request<Machine>(`/api/v1/machines/${encodeURIComponent(id)}`),
      getSubscription: (id: string) =>
        request<MachineSubscription>(`/api/v1/machines/${encodeURIComponent(id)}/subscription`),
      updateSubscription: (id: string, autoRenew: boolean) =>
        request<MachineSubscription>(`/api/v1/machines/${encodeURIComponent(id)}/subscription`, {
          method: "PATCH",
          body: { autoRenew },
        }),
      connection: (id: string) =>
        request<MachineConnection>(`/api/v1/machines/${encodeURIComponent(id)}/connection`),
      createConnectionTicket: (
        id: string,
        channel: MachineConnectionChannel,
        idempotencyKey: string,
      ) =>
        request<MachineConnectionTicket>(
          `/api/v1/machines/${encodeURIComponent(id)}/connection-tickets`,
          {
            method: "POST",
            body: { channel },
            headers: { "idempotency-key": idempotencyKey },
          },
        ),
      provisioning: (id: string) =>
        request<MachineProvisioningStatus>(
          `/api/v1/machines/${encodeURIComponent(id)}/provisioning`,
        ),
      retryProvisioning: (id: string, idempotencyKey: string) =>
        request<MachineProvisioningStatus>(
          `/api/v1/machines/${encodeURIComponent(id)}/provisioning/retry`,
          { method: "POST", headers: { "idempotency-key": idempotencyKey } },
        ),
      events: (id: string, opts: { limit?: number; before?: string } = {}) => {
        const qs = new URLSearchParams();
        if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
        if (opts.before) qs.set("before", opts.before);
        const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
        return request<MachineEventsPage>(
          `/api/v1/machines/${encodeURIComponent(id)}/events${suffix}`,
        );
      },
      create: (input: CreateMachineInput, opts: { idempotencyKey?: string } = {}) =>
        request<Machine>("/api/v1/machines", {
          method: "POST",
          body: input,
          headers: opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {},
        }),
      update: (id: string, input: UpdateMachineInput) =>
        request<Machine>(`/api/v1/machines/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: input,
        }),
      updateEgressLine: (id: string, input: UpdateMachineEgressLineInput, idempotencyKey: string) =>
        request<Machine>(`/api/v1/machines/${encodeURIComponent(id)}/egress-line`, {
          method: "PUT",
          body: input,
          headers: { "idempotency-key": idempotencyKey },
        }),
      start: (id: string) =>
        request<Machine>(`/api/v1/machines/${encodeURIComponent(id)}/start`, { method: "POST" }),
      stop: (id: string) =>
        request<Machine>(`/api/v1/machines/${encodeURIComponent(id)}/stop`, { method: "POST" }),
      reboot: (id: string) =>
        request<Machine>(`/api/v1/machines/${encodeURIComponent(id)}/reboot`, { method: "POST" }),
      rebuild: (id: string, input: RebuildMachineInput = {}) =>
        request<Machine>(`/api/v1/machines/${encodeURIComponent(id)}/rebuild`, {
          method: "POST",
          body: input,
        }),
      getDeletionQuote: (id: string) =>
        request<MachineDeletionQuote>(`/api/v1/machines/${encodeURIComponent(id)}/deletion-quote`, {
          method: "POST",
        }),
      delete: (id: string, deletionQuoteId: string) =>
        request<Machine>(`/api/v1/machines/${encodeURIComponent(id)}`, {
          method: "DELETE",
          body: { deletionQuoteId },
        }),
    },
    workspaces: {
      diff: (workspaceId: string) =>
        request<WorkspaceDiffResult>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/diff`),
      diffFile: (workspaceId: string, file: WorkspaceDiffFileQuery) =>
        request<WorkspaceDiffFileResult>(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/diff/file?${new URLSearchParams(file)}`,
        ),
      list: (machineId: string) =>
        request<Workspace[]>(`/api/v1/machines/${encodeURIComponent(machineId)}/workspaces`),
      create: (machineId: string, input: CreateWorkspaceInput) =>
        request<Workspace>(`/api/v1/machines/${encodeURIComponent(machineId)}/workspaces`, {
          method: "POST",
          body: input,
        }),
      createFromGit: (
        machineId: string,
        input: CreateWorkspaceGitImportInput,
        idempotencyKey: string,
      ) =>
        request<WorkspaceGitImportStart>(
          `/api/v1/machines/${encodeURIComponent(machineId)}/workspace-git-imports`,
          {
            method: "POST",
            body: input,
            headers: { "idempotency-key": idempotencyKey },
          },
        ),
      activeGitImport: (machineId: string) =>
        request<WorkspaceGitImportStatus | null>(
          `/api/v1/machines/${encodeURIComponent(machineId)}/workspace-git-imports/active`,
        ),
      gitImportStatus: (operationId: string, cursor = 0) =>
        request<WorkspaceGitImportStatus>(
          `/api/v1/workspace-git-imports/${encodeURIComponent(operationId)}?cursor=${cursor}`,
        ),
      cancelGitImport: (operationId: string) =>
        request<WorkspaceGitImportStart>(
          `/api/v1/workspace-git-imports/${encodeURIComponent(operationId)}`,
          { method: "DELETE" },
        ),
      get: (workspaceId: string) =>
        request<Workspace>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`),
      update: (workspaceId: string, input: UpdateWorkspaceInput) =>
        request<Workspace>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
          method: "PATCH",
          body: input,
        }),
      delete: (workspaceId: string, options?: { deleteFiles?: boolean }) =>
        request<void>(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}${options?.deleteFiles ? "?deleteFiles=true" : ""}`,
          {
            method: "DELETE",
          },
        ),
      status: (workspaceId: string) =>
        request<WorkspaceRuntimeStatus>(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/status`,
        ),
    },
    cliStore: {
      catalog: () => request<CliApp[]>("/api/v1/cli-store/apps"),
      inventory: (machineId: string) =>
        request<MachineCliInventory>(`/api/v1/machines/${encodeURIComponent(machineId)}/cli-apps`),
      operate: (machineId: string, input: CliStoreOperationInput, idempotencyKey: string) =>
        request<CliOperation>(
          `/api/v1/machines/${encodeURIComponent(machineId)}/cli-apps/operations`,
          { method: "POST", body: input, headers: { "Idempotency-Key": idempotencyKey } },
        ),
      operation: (machineId: string, operationId: string) =>
        request<CliOperation>(
          `/api/v1/machines/${encodeURIComponent(machineId)}/cli-apps/operations/${encodeURIComponent(operationId)}`,
        ),
      cancel: (machineId: string, operationId: string) =>
        request<CliOperation>(
          `/api/v1/machines/${encodeURIComponent(machineId)}/cli-apps/operations/${encodeURIComponent(operationId)}`,
          { method: "DELETE" },
        ),
    },
    workbench: {
      getLayout: (workspaceId: string) =>
        request<WorkbenchLayoutState>(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/workbench-layout`,
        ),
      saveLayout: (workspaceId: string, input: SaveWorkbenchLayoutInput) =>
        request<WorkbenchLayoutState>(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/workbench-layout`,
          { method: "PUT", body: input },
        ),
    },
    plans: {
      list: () => request<Plan[]>("/api/v1/plans"),
      publicCatalog: () =>
        request<PublicPlanCatalog>("/api/v1/public/plans", {
          skipAuthRetry: true,
          omitAccessToken: true,
        }),
    },
    ports: {
      list: (machineId: string) =>
        request<MachinePort[]>(`/api/v1/machines/${encodeURIComponent(machineId)}/ports`),
      listShares: (machineId: string) =>
        request<MachinePortShare[]>(
          `/api/v1/machines/${encodeURIComponent(machineId)}/ports/shares`,
        ),
      setVisibility: (machineId: string, port: number, visibility: PortVisibility) =>
        request<MachinePortRow>(
          `/api/v1/machines/${encodeURIComponent(machineId)}/ports/${port}/visibility`,
          { method: "PUT", body: { visibility } },
        ),
      createShare: (machineId: string, port: number, opts: { expiresInSeconds?: number } = {}) =>
        request<PortShare>(
          `/api/v1/machines/${encodeURIComponent(machineId)}/ports/${port}/shares`,
          { method: "POST", body: { expiresInSeconds: opts.expiresInSeconds ?? null } },
        ),
      deleteShare: (machineId: string, port: number, shareId: string) =>
        request<void>(
          `/api/v1/machines/${encodeURIComponent(machineId)}/ports/${port}/shares/${encodeURIComponent(shareId)}`,
          { method: "DELETE" },
        ),
    },
    snapshots: {
      list: (machineId: string) =>
        request<MachineSnapshot[]>(`/api/v1/machines/${encodeURIComponent(machineId)}/snapshots`),
      create: (machineId: string, name: string) =>
        request<MachineSnapshot>(`/api/v1/machines/${encodeURIComponent(machineId)}/snapshots`, {
          method: "POST",
          body: { name },
        }),
      restore: (machineId: string, snapshotId: string) =>
        request<MachineSnapshot>(
          `/api/v1/machines/${encodeURIComponent(machineId)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
          { method: "POST" },
        ),
      delete: (machineId: string, snapshotId: string) =>
        request<MachineSnapshot>(
          `/api/v1/machines/${encodeURIComponent(machineId)}/snapshots/${encodeURIComponent(snapshotId)}`,
          { method: "DELETE" },
        ),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
import type {
  BankAccountResponse,
  BankAccountView,
  SaveBankAccountInput,
} from "@cloud-machine/client-contracts";
