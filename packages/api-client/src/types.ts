import type {
  MachineProvisionRecoveryAction,
  MachineProvisionStage,
  MachinePublicBandwidthMbps,
  ReferralPageThemeId,
} from "@cloud-machine/client-contracts";

export type {
  MachineProvisionRecoveryAction,
  MachineProvisionStage,
  ReferralPageThemeId,
} from "@cloud-machine/client-contracts";

/**
 * /api/v1 用户态 API 的共享类型（与 apps/api 的 zod response schema 对齐）。
 *
 * 共享类型唯一定义原则（AGENTS.md）：Web / CLI 等客户端一律从这里 import，
 * 不得在各 app 内重复定义 API DTO。
 */

export interface User {
  id: string;
  email: string;
  displayName: string;
  status: "active" | "suspended" | "deleted";
  /** 旧服务端未返回时按未开通处理。 */
  referralEnabled?: boolean;
  /** 推广资格停用后仍保留推广中心和打款历史。 */
  referralProgramExists?: boolean;
  /** 旧服务端可能未返回；null 表示当前账号的每台电脑公网不限速。 */
  machinePublicBandwidthMbps?: MachinePublicBandwidthMbps;
}

export interface AuthResponse {
  accessToken: string;
  user: User;
}

/** 原生 Mobile 登录/注册响应；refresh token 只允许写入系统安全存储。 */
export interface MobileAuthResponse extends AuthResponse {
  refreshToken: string;
  tokenType: "Bearer";
  expiresInSeconds: number;
}

export interface RefreshResponse {
  accessToken: string;
}

export interface RegistrationCodeResponse {
  expiresInSeconds: 600;
  resendAfterSeconds: 60;
}

export interface PasswordResetRequestResponse {
  message: string;
  resendAfterSeconds: 60;
}

export interface ReferralDomainContext {
  active: boolean;
  label: string | null;
  registrationPath: "/register" | null;
  themeId: ReferralPageThemeId | null;
}

export interface ReferralDomainRegistrationResponse {
  handoffToken: string;
  expiresAt: string;
  handoffUrl: string;
  replayed: boolean;
}

export type MachineLifecycleStatus =
  | "provisioning"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "snapshotting"
  | "restoring"
  | "rebuilding"
  | "deleting"
  | "deleted"
  | "error";

export interface Machine {
  id: string;
  name: string;
  slug: string;
  region: string;
  cluster: string;
  clusterGroup: string | null;
  imageId: string;
  imageLabel?: string | null;
  planId: string;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  gpuType: string | null;
  gpuCount: number;
  egressLineId: string;
  egressLineAppliedId: string;
  lifecycleStatus: MachineLifecycleStatus;
  powerState: "unknown" | "on" | "off";
  agentConnectionState: "never_connected" | "connected" | "disconnected";
  readyAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MachineConnection {
  online: boolean;
  agentVersion: string | null;
  contractVersion: number | null;
  gateway: string | null;
}

/** machine_events 对外视图（payload 为透传 jsonb，结构随 eventType 而定）。 */
export interface MachineEvent {
  id: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

/** GET /machines/:id/events 分页响应；nextBefore 为 null 表示没有更多。 */
export interface MachineEventsPage {
  events: MachineEvent[];
  nextBefore: string | null;
}

export interface Plan {
  id: string;
  /** Stable catalog identifier such as Nano or Base. */
  code: string;
  /** User-facing localized plan name. */
  name: string;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  gpuType: string | null;
  gpuCount: number;
  region: string | null;
  hourlyPriceCents: number;
  monthlyPriceCents: number;
  annualPriceCents: number;
}

export type BillingPeriod = "monthly" | "annual";

export interface CreateMachineInput {
  name: string;
  planId: string;
  imageId: string;
  egressLineId?: string;
  sshKeyIds?: string[];
  orderId?: string;
  /** 订单接口缺省为 monthly；机器履约接口忽略该字段。 */
  billingPeriod?: BillingPeriod;
}

export type TrialEntitlementStatus =
  "eligible" | "provisioning" | "active" | "expired" | "converted" | "exhausted" | "revoked";

export interface TrialPlan {
  id: string;
  code: string;
  name: string;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  gpuType: string | null;
  gpuCount: number;
  monthlyPriceCents: number;
  annualPriceCents: number;
}

export interface AccountTrial {
  available: boolean;
  canClaim: boolean;
  status: TrialEntitlementStatus | "unavailable";
  campaignName: string | null;
  durationDays: number | null;
  eligibleUntil: string | null;
  machineId: string | null;
  selectedPlanId: string | null;
  startedAt: string | null;
  trialEndsAt: string | null;
  retentionEndsAt: string | null;
  convertedAt: string | null;
  plans: TrialPlan[];
}

export type ClaimTrialInput = Omit<CreateMachineInput, "orderId">;

export interface UpdateMachineInput {
  name: string;
}

export interface EgressLineOption {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface UpdateMachineEgressLineInput {
  lineId: string;
}

/** POST /machines/:id/rebuild body；sshKeyIds 可选（不传则重建后无 SSH key）。 */
export interface RebuildMachineInput {
  sshKeyIds?: string[];
}

export interface MachineProvisioningStatus {
  machineId: string;
  operationId: string | null;
  status: "queued" | "in_progress" | "retrying" | "ready" | "failed";
  progress: number;
  currentStep: MachineProvisionStage;
  steps: Array<{
    key: MachineProvisionStage;
    status: "pending" | "active" | "completed" | "failed";
  }>;
  attempt: number;
  maxAttempts: number;
  ready: boolean;
  canOpenWorkspace: boolean;
  defaultWorkspaceId: string | null;
  /** 仅失败时返回；决定客户端能否原机重试，不能用订阅文案自行推断。 */
  recoveryAction: MachineProvisionRecoveryAction | null;
  error: { code: string; message: string } | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Workspace / Workbench layout
// ---------------------------------------------------------------------------

export type WorkspaceLifecycleStatus = "creating" | "ready" | "error" | "deleting";

export interface Workspace {
  id: string;
  machineId: string;
  name: string;
  path: string;
  lifecycleStatus: WorkspaceLifecycleStatus;
  /** deleting 状态下为 true 表示正在彻底删除磁盘目录。 */
  deleteFilesRequested: boolean;
  /** 为 true 时，失败的彻底删除可安全降级为仅解除登记。 */
  deleteFilesDowngradeAllowed: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceRuntimeState =
  "available" | "missing" | "not_directory" | "forbidden" | "offline";

export interface WorkspaceRuntimeStatus {
  state: WorkspaceRuntimeState;
  canonicalPath: string | null;
}

export interface CreateWorkspaceGitImportInput {
  name: string;
  path: string;
  repositoryUrl: string;
  credentials?: { username: string; token: string };
  /** Persist private-repository credentials with Git's plaintext store helper. */
  saveCredentials?: boolean;
}

export type WorkspaceGitImportState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface WorkspaceGitImportStart {
  operationId: string;
  workspaceId: string;
  state: WorkspaceGitImportState;
}

export interface WorkspaceGitImportStatus extends WorkspaceGitImportStart {
  stage:
    | "queued"
    | "connecting"
    | "cloning"
    | "publishing"
    | "verifying"
    | "ready"
    | "cancelled"
    | "failed";
  output: string[];
  nextCursor: number;
  error: { code: string; message: string } | null;
  workspace: Workspace;
}

export type TerminalLayoutNode =
  | { type: "terminal-pane"; paneId: string }
  | {
      type: "split";
      splitId: string;
      orientation: "row" | "column";
      ratio: number;
      first: TerminalLayoutNode;
      second: TerminalLayoutNode;
    };

export type WorkbenchTab =
  | {
      id: string;
      type: "explorer";
      activeFilePath: string | null;
      treeSize: number;
      treeCollapsed: boolean;
    }
  | {
      id: string;
      type: "terminal";
      title: string;
      activePaneId: string;
      root: TerminalLayoutNode;
    }
  | { id: string; type: "browser"; url: string }
  | { id: string; type: "diff" };

export interface WorkbenchLayout {
  /** v9-v11 are accepted only for legacy layouts which have not been upgraded. */
  version: 9 | 10 | 11 | 12;
  applicationPane?: import("@cloud-machine/client-contracts").ApplicationPane;
  workspacePane: {
    tabs: WorkbenchTab[];
    activeTabId: string | null;
  };
}

export interface WorkbenchLayoutState {
  layout: WorkbenchLayout;
  revision: number;
}

export interface SaveWorkbenchLayoutInput {
  layout: WorkbenchLayout;
  expectedRevision: number;
}

export interface CreateWorkspaceInput {
  name: string;
  path: string;
  mode: "create" | "register";
}

export interface UpdateWorkspaceInput {
  name: string;
}

// ---------------------------------------------------------------------------
// Ports / Port Preview（设计文档 20 节）
// ---------------------------------------------------------------------------

export type PortVisibility = "private" | "public";

/** GET /machines/:id/ports 条目：运行时监听端口 + DB visibility + previewUrl。 */
export interface MachinePort {
  port: number;
  protocol: "tcp" | "udp";
  address: string;
  process: string | null;
  visibility: PortVisibility;
  previewUrl: string;
}

/** PUT /machines/:id/ports/:port/visibility 响应：ports 行 + previewUrl。 */
export interface MachinePortRow {
  id: string;
  machineId: string;
  port: number;
  protocol: "tcp" | "udp";
  visibility: PortVisibility;
  previewUrl: string;
  createdAt: string;
}

/** POST /machines/:id/ports/:port/shares 响应；expiresAt 为 null 表示不过期。 */
export interface PortShare {
  id: string;
  token: string;
  shareUrl: string;
  expiresAt: string | null;
}

/** GET /machines/:id/ports/shares 条目；附带所属端口便于展示和撤销。 */
export interface MachinePortShare extends PortShare {
  port: number;
}

// ---------------------------------------------------------------------------
// Snapshots（设计文档 Snapshot 章节；Phase 6）
// ---------------------------------------------------------------------------

export type MachineSnapshotStatus = "creating" | "available" | "error";

/** 快照对外视图（不含 incusSnapshotName 等内部资源名）。 */
export interface MachineSnapshot {
  id: string;
  machineId: string;
  name: string;
  sizeBytes: number | null;
  status: MachineSnapshotStatus;
  /** @deprecated `available` 快照均可在电脑停止后恢复；保留用于兼容旧客户端。 */
  restoreEligible: boolean;
  createdAt: string;
}

/** 服务端统一错误体 { error: { code, message } }。 */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Billing / Quota（GET /account/quota|usage）
// ---------------------------------------------------------------------------

export interface AccountQuotaLimits {
  /** null 表示不限制电脑数量。 */
  maxMachines: number | null;
  maxCpu: number;
  maxMemoryMb: number;
  maxDiskGb: number;
}

export interface AccountQuotaUsage {
  machines: number;
  cpu: number;
  memoryMb: number;
  diskGb: number;
}

/** GET /account/quota 响应：配额上限 + 当前用量（仅不含 deleted）。 */
export interface AccountQuota {
  limits: AccountQuotaLimits;
  current: AccountQuotaUsage;
}

export interface AccountUsageMetric {
  metric: string;
  /** numeric 合计，string 序列化防精度丢失。 */
  quantity: string;
}

/** GET /account/usage 响应；from/to 为实际生效窗口（含缺省补齐）。 */
export interface AccountUsage {
  from: string;
  to: string;
  metrics: AccountUsageMetric[];
}

// ---------------------------------------------------------------------------
// Commerce / wallet / prepaid machine subscriptions
// ---------------------------------------------------------------------------

export interface BillingCapabilities {
  /** 商业账务、订单查询及订阅状态机可用。 */
  enabled: boolean;
  /** 当前允许创建新订单和发起支付。 */
  checkoutEnabled: boolean;
  /** 当前允许使用非生产环境的免费机器创建链路。 */
  legacyFreeMachineCreationEnabled: boolean;
  currency: "CNY";
  rechargeMinCents: number;
  rechargeMaxCents: number;
  rechargePresetsCents: number[];
  /** 当前允许创建新订单的周期；旧服务端缺省按仅月付处理。 */
  billingPeriods?: BillingPeriod[];
}

export interface Wallet {
  availableCents: number;
  frozenCents: number;
  currency: "CNY";
}

export interface WalletTransaction {
  id: string;
  type: string;
  availableDeltaCents: number;
  frozenDeltaCents: number;
  availableAfterCents: number;
  frozenAfterCents: number;
  description: string;
  createdAt: string;
}

export interface WalletTransactionsPage {
  transactions: WalletTransaction[];
  nextBefore: string | null;
  nextBeforeId: string | null;
}

export type CommerceOrderType = "recharge" | "machine_purchase" | "machine_renewal";
export type CommerceOrderStatus =
  | "pending_payment"
  | "paid"
  | "fulfilling"
  | "fulfilled"
  | "closed"
  | "refund_pending"
  | "partially_refunded"
  | "refunded"
  | "failed";

export interface CommerceOrder {
  id: string;
  orderNo: string;
  type: CommerceOrderType;
  status: CommerceOrderStatus;
  amountCents: number;
  refundedCents: number;
  currency: "CNY";
  description: string;
  productSnapshot: unknown;
  billingPeriod: BillingPeriod | null;
  machineId: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  fulfilledAt: string | null;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  servicePeriodDays: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceOrdersPage {
  orders: CommerceOrder[];
  nextBefore: string | null;
  nextBeforeId: string | null;
}

export type WechatPaymentScene = "native" | "h5" | "jsapi";
export type PaymentAction =
  | { kind: "none" }
  | { kind: "wechat_oauth"; authorizeUrl: string }
  | { kind: "native_qr"; codeUrl: string; expiresAt: string }
  | { kind: "h5_redirect"; h5Url: string; expiresAt: string }
  | {
      kind: "jsapi";
      appId: string;
      timeStamp: string;
      nonceStr: string;
      package: string;
      signType: "RSA";
      paySign: string;
      expiresAt: string;
    };

export interface PaymentResponse {
  order: CommerceOrder;
  action: PaymentAction;
}

export interface MachineSubscription {
  status: "grandfathered" | "active" | "grace" | "suspended" | "terminated";
  autoRenew: boolean;
  renewalPriceCents: number;
  billingPeriod: BillingPeriod;
  renewalPeriodDays: 30 | 365;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  retentionEndsAt: string | null;
  trial: {
    status: Exclude<TrialEntitlementStatus, "eligible">;
    startedAt: string | null;
    trialEndsAt: string | null;
    retentionEndsAt: string | null;
  } | null;
}

export interface MachineDeletionQuoteItem {
  orderId: string;
  orderType: "machine_purchase" | "machine_renewal";
  description: string;
  amountCents: number;
  refundedCents: number;
  refundCents: number;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  servicePeriodDays: number;
  usedDays: number;
  remainingDays: number;
}

export interface MachineDeletionQuote {
  quoteId: string;
  machineId: string;
  quotedAt: string;
  expiresAt: string;
  totalRefundCents: number;
  currency: "CNY";
  destination: "balance";
  items: MachineDeletionQuoteItem[];
}

export interface AccountNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  relatedType: string | null;
  relatedId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface AccountNotificationSummary {
  items: AccountNotification[];
  unreadCount: number;
}

export interface MarkAllNotificationsReadResponse {
  updated: number;
  readAt: string;
}

// ---------------------------------------------------------------------------
// Referral program
// ---------------------------------------------------------------------------

export interface ReferralRate {
  planId: string;
  planName: string;
  platformPriceCents: number;
  costPriceCents: number;
  salePriceCents: number;
  commissionCents: number;
  costInherited: boolean;
  saleInherited: boolean;
  annualPlatformPriceCents: number;
  annualCostPriceCents: number;
  annualSalePriceCents: number;
  annualCommissionCents: number;
  annualCostInherited: boolean;
  annualSaleInherited: boolean;
  /** @deprecated 兼容旧客户端；等同 commissionCents。 */
  globalCommissionCents: number;
  /** @deprecated 新定价不再使用固定佣金覆盖。 */
  overrideCommissionCents: number | null;
  /** @deprecated 兼容旧客户端；等同 commissionCents。 */
  effectiveCommissionCents: number;
}

export interface ReferralDomain {
  label: string;
  url: string;
  editable: boolean;
  renameSequence: number;
  remainingRenames: number;
  nextRenameAt: string | null;
}

export interface ReferralOverview {
  enabled: boolean;
  pageThemeId: ReferralPageThemeId;
  /** @deprecated 兼容旧客户端；值为专属域名。 */
  shareUrl: string | null;
  domain: ReferralDomain | null;
  settledBalanceCents: number;
  reservedPayoutCents: number;
  paidOutCents: number;
  availablePayoutCents: number;
  offsetDebtCents: number;
  pendingBalanceCents: number;
  referredUsers: number;
  payoutBindingEnabled: boolean;
  wechatAuthorization: {
    id: string;
    status:
      "pending_user_confirmation" | "active" | "close_requested" | "closed" | "expired" | "failed";
    recipientNameMasked: string | null;
    expiresAt: string;
    authorizedAt: string | null;
  } | null;
  rates: ReferralRate[];
}

export type ReferralListOptions =
  | {
      limit?: number;
      cursor?: string;
      page?: never;
      pageSize?: never;
    }
  | {
      limit?: never;
      cursor?: never;
      page: number;
      pageSize: number;
    };

export interface ReferralPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ReferralPage<T> {
  items: T[];
  nextCursor: string | null;
  pagination: ReferralPagination | null;
}

export interface ReferredUser {
  id: string;
  email: string;
  boundAt: string;
  orderCount: number;
  commissionCents: number;
}

export interface ReferralCommission {
  id: string;
  orderId: string;
  email: string;
  planName: string;
  orderType: "machine_purchase" | "machine_renewal";
  orderAmountCents: number;
  commissionCents: number;
  earnedCommissionCents: number;
  billingPeriod: BillingPeriod;
  installmentCount: number;
  releasedInstallments: number;
  settledCents: number;
  nextReleaseAt: string | null;
  status: "pending" | "settled" | "adjusting" | "adjusted" | "voided";
  availableAt: string;
  createdAt: string;
}

export interface ReferralOrder {
  id: string;
  email: string;
  planName: string;
  orderType: "machine_purchase" | "machine_renewal";
  orderAmountCents: number;
  commissionCents: number;
  earnedCommissionCents: number;
  billingPeriod: BillingPeriod;
  status: CommerceOrderStatus;
  refundedCents: number;
  createdAt: string;
}

export interface ReferralSettlement {
  id: string;
  month: string;
  amountCents: number;
  createdAt: string;
}

export type { ReferralPayout } from "@cloud-machine/client-contracts";

export interface ReferralPayoutBindingSession {
  id: string;
  bindUrl: string;
  expiresAt: string;
}

export interface ReferralPayoutBindingStatus {
  id: string;
  status: NonNullable<ReferralOverview["wechatAuthorization"]>["status"];
  packageInfo: string | null;
  failureCode: string | null;
  mchId: string;
  appId: string;
  expiresAt: string;
}

export interface WechatJsapiConfig {
  appId: string;
  timestamp: number;
  nonceStr: string;
  signature: string;
}
