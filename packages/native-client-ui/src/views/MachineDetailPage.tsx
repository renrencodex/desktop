/**
 * /machines/$id：电脑级详情（Overview/Ports/Snapshots）。Terminal 与 Files 已下沉到
 * Development Directory Pane，电脑根页面不重复呈现目录级能力。
 *
 * - Overview：名称 / region / lifecycle / 规格 / 电脑通道状态 + Start/Stop/Reboot/Rebuild/Delete；
 * - 状态机约束与后端一致（4.1）：stopped→start、running→stop/reboot、
 *   running/stopped/error→rebuild，provisioning/starting/running/stopped/error→delete；
 * - 停止、重启、删除与 Rebuild 走二次确认对话框（Rebuild 会清空系统盘，红字警示）；
 * - Snapshots 页签不受 Running 门槛限制（restore 正需要 stopped 状态）；
 * - Terminal 页签懒加载 xterm（避免首屏拉入 xterm CSS/JS，也便于 bun test 隔离）；
 * - Overview 页签含 Metrics 卡片（RPC 轮询 system.metrics）。
 */
"use client";

import {
  isApiError,
  type BillingPeriod,
  type CommerceOrder,
  type EgressLineOption,
  type Machine,
  type MachineDeletionQuote,
  type MachineEvent,
  type MachineProvisioningStatus,
} from "@cloud-machine/api-client";
import { isMachineRuntimeAvailable } from "@cloud-machine/client-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  CircleGauge,
  Globe2,
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  Network,
  Pencil,
  Play,
  RotateCcw,
  Square,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useRouter } from "../host";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { CliStorePanel } from "../components/CliStorePanel";
import { EgressLineDialog } from "../components/EgressLineDialog";
import { MachineDeletionQuoteSummary } from "../components/MachineDeletionQuoteSummary";
import { PaymentDialog } from "../components/PaymentDialog";
import { RenameDialog } from "../components/RenameDialog";
import { MetricsCard } from "../components/MetricsCard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { ConnectionBadge, LifecycleBadge } from "../components/StatusBadge";
import { api } from "../lib/api";
import {
  lifecycleLabel,
  peakBandwidthLabel,
  planLabel,
  powerLabel,
  regionLabel,
} from "../lib/display-labels";
import {
  cacheMachineDetail,
  clearMachineDetailCache,
  readMachineDetailCache,
} from "../lib/machine-detail-cache";
import { machineMetricsCache } from "../lib/machine-metrics-cache";
import { canRebuild } from "../lib/rebuild-utils";
import { isNotFoundError, userErrorMessage } from "../lib/user-error";
import { focusTabAt, tablistArrowTarget } from "../lib/tablist-navigation";
import { subscribeWorkbenchCommands } from "../lib/workbench-commands";
import { toastError, toastSuccess } from "../stores/toast";
import { useWorkbenchStore } from "../stores/workbench";
import { useAuthStore } from "../stores/auth";

const PortsPanel = lazy(() =>
  import("../components/PortsPanel").then((m) => ({ default: m.PortsPanel })),
);
const RescueTerminalDialog = lazy(() =>
  import("../components/RescueTerminalDialog").then((m) => ({ default: m.RescueTerminalDialog })),
);
const SnapshotsPanel = lazy(() =>
  import("../components/SnapshotsPanel").then((m) => ({ default: m.SnapshotsPanel })),
);

const TRANSITIONAL: ReadonlySet<Machine["lifecycleStatus"]> = new Set([
  "provisioning",
  "starting",
  "stopping",
  "snapshotting",
  "restoring",
  "rebuilding",
  "deleting",
]);

type Tab = "overview" | "ports" | "snapshots";
type ConfirmLifecycleAction = "stop" | "reboot";

interface RebootFeedback {
  machineId: string;
  requestedAt: number;
  baselineEventIds: string[] | null;
}

const REBOOT_MAX_ATTEMPTS = 3;

function eventsAfterRebootRequest(
  events: MachineEvent[],
  feedback: RebootFeedback,
): MachineEvent[] {
  if (feedback.baselineEventIds) {
    return events.filter((event) => !feedback.baselineEventIds?.includes(event.id));
  }
  return events.filter((event) => {
    const createdAt = Date.parse(event.createdAt);
    return Number.isFinite(createdAt) && createdAt >= feedback.requestedAt - 5000;
  });
}

const MACHINE_TABS: ReadonlyArray<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: "overview", label: "面板", icon: <CircleGauge size={13} /> },
  { id: "ports", label: "端口", icon: <Network size={13} /> },
  { id: "snapshots", label: "备份", icon: <Archive size={13} /> },
];
const MACHINE_TABLIST_CLASS_NAME =
  "flex min-h-9 shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-zinc-800 bg-zinc-900 px-2 py-1";

function machineTabClassName(active: boolean) {
  return `${active ? "cm-button-primary" : "cm-button"} shrink-0`;
}

export function MachineDetailPage({ machineId }: { machineId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const sessionUser = useAuthStore((state) => state.user);
  const accountId = sessionUser?.id;
  const rememberedTab = useWorkbenchStore((state) => state.machineTabs[machineId] ?? "overview");
  const rememberMachineTab = useWorkbenchStore((state) => state.rememberMachineTab);
  const [tab, setTabState] = useState<Tab>(rememberedTab);
  const [mountedTabs, setMountedTabs] = useState<Set<Tab>>(() => new Set([rememberedTab]));
  const setTab = (view: Tab) => {
    setMountedTabs((current) => (current.has(view) ? current : new Set([...current, view])));
    setTabState(view);
    rememberMachineTab(machineId, view);
  };
  const [confirmLifecycleAction, setConfirmLifecycleAction] =
    useState<ConfirmLifecycleAction | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rescueOpen, setRescueOpen] = useState(false);
  const [deletionQuote, setDeletionQuote] = useState<MachineDeletionQuote | null>(null);
  const [deletionQuoteError, setDeletionQuoteError] = useState<string | null>(null);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [egressOpen, setEgressOpen] = useState(false);
  const [egressLineId, setEgressLineId] = useState("");
  const [egressError, setEgressError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rebootFeedback, setRebootFeedback] = useState<RebootFeedback | null>(null);
  const [rebootFailureAttempts, setRebootFailureAttempts] = useState(0);
  const [renewalOrder, setRenewalOrder] = useState<CommerceOrder | null>(null);
  const [renewalBillingPeriod, setRenewalBillingPeriod] = useState<BillingPeriod | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const renewalIdempotencyKey = useRef(crypto.randomUUID());
  const egressIdempotencyKey = useRef(crypto.randomUUID());
  const dirtyFileCount = useWorkbenchStore((state) => state.dirtyFileCount);

  useEffect(
    () =>
      subscribeWorkbenchCommands((command) => {
        if (command.type === "machine.view") {
          setMountedTabs((current) =>
            current.has(command.view) ? current : new Set([...current, command.view]),
          );
          setTabState(command.view);
          rememberMachineTab(machineId, command.view);
        }
      }),
    [machineId, rememberMachineTab],
  );

  const machineQuery = useQuery({
    queryKey: ["machine", machineId],
    queryFn: () => api.machines.get(machineId),
    // Only a temporary visual placeholder; never publish stored data to the query cache.
    placeholderData: () =>
      accountId
        ? (queryClient
            .getQueryData<Machine[]>(["machines"])
            ?.find((machine) => machine.id === machineId) ??
          readMachineDetailCache(accountId, machineId)?.machine)
        : undefined,
    // 过渡态 3s 轮询直到稳定；稳定后 15s 慢轮询保持 agent/power 状态新鲜。
    refetchInterval: (query) =>
      query.state.data &&
      (TRANSITIONAL.has(query.state.data.lifecycleStatus) ||
        query.state.data.egressLineId !== query.state.data.egressLineAppliedId)
        ? 3000
        : 15000,
  });
  const currentUserQuery = useQuery({
    queryKey: ["current-user", accountId],
    queryFn: () => api.auth.me(),
    enabled: Boolean(accountId),
    placeholderData: sessionUser ?? undefined,
    staleTime: 60_000,
  });
  const egressLinesQuery = useQuery({
    queryKey: ["egress-lines"],
    queryFn: () => api.machines.listEgressLines(),
  });
  const plansQuery = useQuery({ queryKey: ["plans"], queryFn: () => api.plans.list() });
  const capabilitiesQuery = useQuery({
    queryKey: ["billing-capabilities"],
    queryFn: () => api.account.getBillingCapabilities(),
  });
  const subscriptionQuery = useQuery({
    queryKey: ["machine-subscription", machineId],
    queryFn: () => api.machines.getSubscription(machineId),
    enabled: capabilitiesQuery.data?.enabled === true,
    retry: false,
    refetchInterval: 15_000,
  });
  const machineNotFound = isNotFoundError(machineQuery.error);
  const provisioningReady =
    queryClient.getQueryData<MachineProvisioningStatus>(["machine-provisioning", machineId])
      ?.ready === true;

  useEffect(() => {
    if (accountId && machineQuery.data && !machineQuery.isPlaceholderData)
      cacheMachineDetail(
        accountId,
        machineQuery.data,
        plansQuery.data?.find((candidate) => candidate.id === machineQuery.data?.planId)?.name,
      );
  }, [accountId, machineQuery.data, machineQuery.isPlaceholderData, plansQuery.data]);

  useEffect(() => {
    if (machineNotFound) {
      machineMetricsCache.invalidate(accountId ?? null, machineId);
      clearMachineDetailCache();
      router.replace("/machines");
    }
  }, [accountId, machineId, machineNotFound, router]);

  useEffect(() => {
    const machine = machineQuery.data;
    if (!machine || machineQuery.isPlaceholderData) return;
    if (machine.readyAt !== null) {
      if (provisioningReady) {
        queryClient.removeQueries({
          queryKey: ["machine-provisioning", machineId],
          exact: true,
        });
      }
      return;
    }
    if (!provisioningReady) {
      router.replace(`/machines/${machine.id}/provisioning`);
    }
  }, [
    machineId,
    machineQuery.data,
    machineQuery.isPlaceholderData,
    provisioningReady,
    queryClient,
    router,
  ]);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["machine", machineId] });
  const onActionError = (err: unknown) => setActionError(userErrorMessage(err, "操作失败，请重试"));

  const action = useMutation({
    mutationFn: async (op: "start" | "stop" | "reboot") => {
      let feedback: RebootFeedback | null = null;
      if (op === "reboot") {
        let baselineEventIds: string[] | null = null;
        try {
          const baseline = await api.machines.events(machineId, { limit: 50 });
          baselineEventIds = baseline.events.map((event) => event.id);
        } catch {
          // 事件基线不可用不应阻止重启；结果轮询会退回到服务端事件时间判断。
        }
        feedback = { machineId, requestedAt: Date.now(), baselineEventIds };
      }
      await api.machines[op](machineId);
      return { op, feedback };
    },
    onSuccess: ({ op, feedback }) => {
      if (op !== "start") machineMetricsCache.invalidate(accountId ?? null, machineId);
      setConfirmLifecycleAction(null);
      setActionError(null);
      if (op === "reboot" && feedback) {
        setRebootFailureAttempts(0);
        setRebootFeedback(feedback);
        toastSuccess("重启任务已提交");
      }
      void invalidate();
    },
    onError: (error, op) => {
      setConfirmLifecycleAction(null);
      const message = userErrorMessage(error, "操作失败，请重试");
      setActionError(message);
      if (op === "reboot") toastError(message);
    },
  });
  const activeRebootFeedback = rebootFeedback?.machineId === machineId ? rebootFeedback : null;

  useEffect(() => {
    if (!activeRebootFeedback) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const page = await api.machines.events(machineId, { limit: 50 });
        if (cancelled) return;
        const events = eventsAfterRebootRequest(page.events, activeRebootFeedback);
        if (events.some((event) => event.eventType === "machine.rebooted")) {
          cancelled = true;
          setRebootFeedback(null);
          setActionError(null);
          toastSuccess("电脑重启完成");
          void queryClient.invalidateQueries({ queryKey: ["machine", machineId] });
          return;
        }
        const failedAttempts = events.filter(
          (event) => event.eventType === "machine.reboot_failed",
        ).length;
        if (failedAttempts >= REBOOT_MAX_ATTEMPTS) {
          cancelled = true;
          const message = "电脑重启失败，请稍后重试";
          setRebootFeedback(null);
          setActionError(message);
          toastError(message);
          void queryClient.invalidateQueries({ queryKey: ["machine", machineId] });
          return;
        }
        setRebootFailureAttempts(failedAttempts);
      } catch {
        // 临时无法读取事件时继续轮询，避免把状态查询失败误报为重启失败。
      }
      if (!cancelled) timeout = setTimeout(() => void poll(), 3000);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [activeRebootFeedback, machineId, queryClient]);
  const deletionQuoteMutation = useMutation({
    mutationFn: () => api.machines.getDeletionQuote(machineId),
    onSuccess: (quote) => {
      setDeletionQuote(quote);
      setDeletionQuoteError(null);
      setConfirmDelete(true);
    },
    onError: (error) => {
      setDeletionQuote(null);
      setDeletionQuoteError(userErrorMessage(error, "退款金额计算失败，请重试"));
      setConfirmDelete(true);
    },
  });
  const openDeleteConfirmation = () => {
    setConfirmDelete(false);
    setDeletionQuote(null);
    setDeletionQuoteError(null);
    deletionQuoteMutation.mutate();
  };
  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!deletionQuote) throw new Error("删除报价尚未生成");
      return api.machines.delete(machineId, deletionQuote.quoteId);
    },
    onSuccess: () => {
      setConfirmDelete(false);
      machineMetricsCache.invalidate(accountId ?? null, machineId);
      setActionError(null);
      toastSuccess(
        deletionQuote && deletionQuote.totalRefundCents > 0
          ? `电脑删除任务已提交，¥${(deletionQuote.totalRefundCents / 100).toFixed(2)} 已退至账户余额`
          : "电脑删除任务已提交",
      );
      clearMachineDetailCache();
      void queryClient.invalidateQueries({ queryKey: ["machines"] });
      void queryClient.invalidateQueries({ queryKey: ["wallet"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      router.push("/machines");
    },
    // 失败也要关掉确认框，否则概览中的错误提示会被对话框挡住。
    onError: (err) => {
      if (
        isApiError(err) &&
        (err.code === "REFUND_QUOTE_CHANGED" || err.code === "DELETION_QUOTE_EXPIRED")
      ) {
        setConfirmDelete(false);
        setDeletionQuote(null);
        setDeletionQuoteError(null);
        toastError("退款金额已变化，正在重新获取删除信息");
        deletionQuoteMutation.mutate();
        return;
      }
      setConfirmDelete(false);
      const message = userErrorMessage(err, "删除电脑失败，请重试");
      setActionError(message);
      toastError(message);
    },
  });
  const rebuildMutation = useMutation({
    mutationFn: () => api.machines.rebuild(machineId),
    onSuccess: () => {
      setConfirmRebuild(false);
      machineMetricsCache.invalidate(accountId ?? null, machineId);
      setActionError(null);
      void invalidate();
    },
    onError: (err) => {
      setConfirmRebuild(false);
      onActionError(err);
    },
  });
  const renameMutation = useMutation({
    mutationFn: (name: string) => api.machines.update(machineId, { name }),
    onSuccess: (updated) => {
      queryClient.setQueryData<Machine>(["machine", machineId], updated);
      queryClient.setQueryData<Machine[]>(["machines"], (current) =>
        current?.map((machine) => (machine.id === updated.id ? updated : machine)),
      );
      setRenameOpen(false);
      setRenameError(null);
    },
    onError: (error) => setRenameError(userErrorMessage(error, "重命名电脑失败")),
  });
  const egressMutation = useMutation({
    mutationFn: (lineId: string) =>
      api.machines.updateEgressLine(machineId, { lineId }, egressIdempotencyKey.current),
    onSuccess: (updated) => {
      queryClient.setQueryData<Machine>(["machine", machineId], updated);
      queryClient.setQueryData<Machine[]>(["machines"], (current) =>
        current?.map((machine) => (machine.id === updated.id ? updated : machine)),
      );
      setEgressOpen(false);
      setEgressError(null);
      egressIdempotencyKey.current = crypto.randomUUID();
      toastSuccess("网络线路切换任务已提交");
      void invalidate();
    },
    onError: (error) => {
      if (
        isApiError(error) &&
        ["ENQUEUE_FAILED", "EGRESS_UPDATE_FAILED", "IDEMPOTENCY_CONFLICT"].includes(error.code)
      ) {
        // 服务端已经明确拒绝或终结了这个请求；后续重试必须使用新的幂等键。
        egressIdempotencyKey.current = crypto.randomUUID();
      }
      setEgressError(userErrorMessage(error, "网络线路切换失败"));
    },
  });
  const autoRenewMutation = useMutation({
    mutationFn: (autoRenew: boolean) => api.machines.updateSubscription(machineId, autoRenew),
    onSuccess: (subscription) =>
      queryClient.setQueryData(["machine-subscription", machineId], subscription),
    onError: onActionError,
  });
  const renewalMutation = useMutation({
    mutationFn: (billingPeriod: BillingPeriod) =>
      api.orders.createRenewal(machineId, renewalIdempotencyKey.current, billingPeriod),
    onSuccess: (order) => {
      setRenewalOrder(order);
      setPaymentOpen(true);
      renewalIdempotencyKey.current = crypto.randomUUID();
    },
    onError: onActionError,
  });

  if (machineNotFound) {
    return null;
  }
  if (machineQuery.isPending) {
    return <MachineDetailSkeleton tab={tab} />;
  }
  if (machineQuery.isPlaceholderData && tab !== "overview") {
    return <MachineDetailSkeleton tab={tab} />;
  }
  if (machineQuery.isError || !machineQuery.data) {
    return (
      <div className="p-6 text-sm text-red-300">
        {userErrorMessage(machineQuery.error, "加载电脑详情失败，请稍后重试")}
      </div>
    );
  }
  if (provisioningReady && machineQuery.data.readyAt === null) {
    return <MachineDetailSkeleton tab={tab} />;
  }

  const m = machineQuery.data;
  const showingCachedDetail = machineQuery.isPlaceholderData;
  const runtimeAvailable = isMachineRuntimeAvailable(m);
  const plan = plansQuery.data?.find((candidate) => candidate.id === m.planId);
  const peakBandwidth = peakBandwidthLabel(currentUserQuery.data?.machinePublicBandwidthMbps);
  const selectedRenewalPeriod =
    renewalOrder?.status === "pending_payment" && renewalOrder.billingPeriod
      ? renewalOrder.billingPeriod
      : (renewalBillingPeriod ?? subscriptionQuery.data?.billingPeriod ?? "monthly");
  const annualRenewalEnabled = capabilitiesQuery.data?.billingPeriods?.includes("annual") === true;
  const trialNeedsConversion = Boolean(
    subscriptionQuery.data?.trial && subscriptionQuery.data.trial.status !== "converted",
  );
  const selectedRenewalPriceCents = subscriptionQuery.data
    ? trialNeedsConversion || selectedRenewalPeriod !== subscriptionQuery.data.billingPeriod
      ? selectedRenewalPeriod === "annual"
        ? plan?.annualPriceCents
        : plan?.monthlyPriceCents
      : subscriptionQuery.data.renewalPriceCents
    : undefined;
  const selectedRenewalUnavailable = selectedRenewalPeriod === "annual" && !annualRenewalEnabled;
  const cachedPlanName = accountId ? readMachineDetailCache(accountId, machineId)?.planName : null;
  const region = regionLabel(m.region);
  const busy = TRANSITIONAL.has(m.lifecycleStatus);
  const entitlementInactive =
    subscriptionQuery.data?.status === "suspended" ||
    subscriptionQuery.data?.status === "terminated";
  const entitlementUnknown = capabilitiesQuery.data?.enabled === true && !subscriptionQuery.data;
  const canStart = m.lifecycleStatus === "stopped" && !entitlementInactive && !entitlementUnknown;
  const canStop = m.lifecycleStatus === "running";
  const canReboot = m.lifecycleStatus === "running" && !entitlementInactive && !entitlementUnknown;
  const canDelete = ["provisioning", "starting", "running", "stopped", "error"].includes(
    m.lifecycleStatus,
  );
  const lifecycleActionPending = action.isPending || activeRebootFeedback !== null;

  const mainContent = (
    <div className="relative h-full min-h-0">
      {mountedTabs.has("overview") && (
        <KeepAlivePanel active={tab === "overview"}>
          <div className="h-full overflow-auto p-3 sm:p-4">
            {/* 电脑基本信息与操作仅属于概览，其他能力页保持专注。 */}
            <section className="cm-panel overflow-hidden">
              <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
                <span className="flex h-7 w-7 items-center justify-center rounded border border-zinc-800 bg-zinc-950 text-zinc-500">
                  <Monitor size={14} />
                </span>
                <div className="min-w-0">
                  <h1 className="truncate text-xs font-medium text-zinc-100">{m.name}</h1>
                  {region ? (
                    <span className="block text-[10px] text-zinc-600">{region}</span>
                  ) : null}
                </div>
                <LifecycleBadge status={m.lifecycleStatus} />
                <ConnectionBadge state={m.agentConnectionState} />
                <span className="hidden text-[11px] text-zinc-500 xl:inline">
                  {m.cpu} CPU · {(m.memoryMb / 1024).toFixed(0)} GB · {m.diskGb} GB
                  {m.gpuCount > 0 ? ` · ${m.gpuCount}× ${m.gpuType ?? "GPU"}` : ""}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <ActionButton
                    icon={<Play size={12} />}
                    disabled={showingCachedDetail || !canStart || lifecycleActionPending}
                    onClick={() => action.mutate("start")}
                  >
                    启动
                  </ActionButton>
                  <ActionButton
                    icon={<Square size={11} />}
                    disabled={showingCachedDetail || !canStop || lifecycleActionPending}
                    onClick={() => {
                      if (dirtyFileCount > 0) {
                        setActionError(`还有 ${dirtyFileCount} 个文件未保存，请保存后再停止电脑`);
                      } else {
                        setActionError(null);
                        setConfirmLifecycleAction("stop");
                      }
                    }}
                  >
                    停止
                  </ActionButton>
                  <ActionButton
                    icon={<RotateCcw size={12} />}
                    disabled={showingCachedDetail || !canReboot || lifecycleActionPending}
                    onClick={() => {
                      setActionError(null);
                      setConfirmLifecycleAction("reboot");
                    }}
                    className="hidden sm:inline-flex"
                  >
                    重启
                  </ActionButton>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <button
                          type="button"
                          className="cm-icon-button"
                          title={deletionQuoteMutation.isPending ? "正在准备删除确认" : "更多操作"}
                          disabled={showingCachedDetail || deletionQuoteMutation.isPending}
                        />
                      }
                    >
                      {deletionQuoteMutation.isPending ? (
                        <LoaderCircle
                          size={14}
                          className="motion-safe:animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <MoreHorizontal size={14} />
                      )}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" sideOffset={4}>
                      <DropdownMenuItem
                        className="sm:hidden"
                        disabled={!canReboot || lifecycleActionPending}
                        onClick={() => {
                          setActionError(null);
                          setConfirmLifecycleAction("reboot");
                        }}
                      >
                        <RotateCcw size={13} /> 重启电脑
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={renameMutation.isPending}
                        onClick={() => {
                          setRenameError(null);
                          setRenameOpen(true);
                        }}
                      >
                        <Pencil size={13} /> 重命名
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={
                          egressLinesQuery.isPending ||
                          egressLinesQuery.isError ||
                          !["running", "stopped"].includes(m.lifecycleStatus) ||
                          m.egressLineId !== m.egressLineAppliedId ||
                          egressMutation.isPending
                        }
                        onClick={() => {
                          setEgressLineId(m.egressLineId);
                          setEgressError(null);
                          egressIdempotencyKey.current = crypto.randomUUID();
                          setEgressOpen(true);
                        }}
                      >
                        <Globe2 size={13} /> 网络线路
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={
                          entitlementInactive ||
                          entitlementUnknown ||
                          !["running", "error"].includes(m.lifecycleStatus)
                        }
                        onClick={() => setRescueOpen(true)}
                      >
                        <TerminalSquare size={13} /> 救援终端
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={
                          entitlementInactive ||
                          entitlementUnknown ||
                          !canRebuild(m.lifecycleStatus) ||
                          rebuildMutation.isPending
                        }
                        onClick={() => setConfirmRebuild(true)}
                      >
                        <RotateCcw size={13} /> 重装系统
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        className="text-red-400"
                        disabled={
                          !canDelete || deleteMutation.isPending || deletionQuoteMutation.isPending
                        }
                        onClick={openDeleteConfirmation}
                      >
                        <Trash2 size={13} /> 删除电脑
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              {showingCachedDetail && (
                <span className="sr-only" role="status">
                  正在更新电脑信息
                </span>
              )}
              {busy && (
                <p className="border-t px-3 py-1 text-[10px] cm-banner-warning animate-in slide-in-from-top-1 fade-in duration-150">
                  电脑正在{lifecycleLabel(m.lifecycleStatus)}，操作完成后按钮自动恢复（每 3 秒刷新）
                </p>
              )}
              {activeRebootFeedback && (
                <p
                  role="status"
                  className="flex items-center gap-1.5 border-t px-3 py-1 text-[10px] cm-banner-warning animate-in slide-in-from-top-1 fade-in duration-150"
                >
                  <LoaderCircle
                    size={11}
                    className="shrink-0 motion-safe:animate-spin"
                    aria-hidden="true"
                  />
                  {rebootFailureAttempts > 0
                    ? "电脑重启暂未完成，系统正在自动重试"
                    : "重启任务已提交，正在等待执行结果（每 3 秒检查）"}
                </p>
              )}
              {actionError && (
                <p className="border-t px-3 py-1 text-[10px] cm-banner-danger animate-in slide-in-from-top-1 fade-in duration-150">
                  {actionError}
                </p>
              )}
            </section>

            {capabilitiesQuery.data?.enabled && subscriptionQuery.data && (
              <section className="cm-panel mt-3 flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1 basis-56">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-zinc-200">订阅与续费</span>
                    <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
                      {subscriptionStatusLabel(subscriptionQuery.data.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    {subscriptionQuery.data.trial?.status === "provisioning"
                      ? selectedRenewalPriceCents === undefined
                        ? "免费试用将在电脑开通后开始，可选择月付或年付转为付费"
                        : `免费试用将在电脑开通后开始，当前${billingPeriodLabel(selectedRenewalPeriod)}转付费价格 ¥${(selectedRenewalPriceCents / 100).toFixed(2)}/${billingPeriodDurationLabel(selectedRenewalPeriod)}`
                      : subscriptionQuery.data.trial?.status === "active" &&
                          subscriptionQuery.data.trial.trialEndsAt
                        ? selectedRenewalPriceCents === undefined
                          ? `免费试用中 · 剩余 ${formatTrialRemaining(subscriptionQuery.data.trial.trialEndsAt)}`
                          : `免费试用中 · 剩余 ${formatTrialRemaining(subscriptionQuery.data.trial.trialEndsAt)} · 当前${billingPeriodLabel(selectedRenewalPeriod)}转付费 ¥${(selectedRenewalPriceCents / 100).toFixed(2)}/${billingPeriodDurationLabel(selectedRenewalPeriod)}`
                        : subscriptionQuery.data.trial?.status === "expired"
                          ? `试用已到期，可选择月付或年付恢复使用`
                          : subscriptionQuery.data.status === "grandfathered"
                            ? "当前电脑沿用开发期免费权益，首次续费后转为付费订阅"
                            : `${billingPeriodLabel(subscriptionQuery.data.billingPeriod)}续费价 ¥${(subscriptionQuery.data.renewalPriceCents / 100).toFixed(2)}/${billingPeriodDurationLabel(subscriptionQuery.data.billingPeriod)}${
                                subscriptionQuery.data.currentPeriodEnd
                                  ? ` · 到期 ${new Date(subscriptionQuery.data.currentPeriodEnd).toLocaleString()}`
                                  : ""
                              }`}
                  </p>
                  {subscriptionQuery.data.graceEndsAt && (
                    <p className="mt-1 text-[11px] text-amber-400">
                      请在 {new Date(subscriptionQuery.data.graceEndsAt).toLocaleString()} 前续费
                    </p>
                  )}
                  {subscriptionQuery.data.retentionEndsAt && (
                    <p className="mt-1 text-[11px] text-red-400">
                      数据保留至 {new Date(subscriptionQuery.data.retentionEndsAt).toLocaleString()}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950 p-1">
                  {(["monthly", "annual"] as const).map((period) => {
                    const unavailable = period === "annual" && !annualRenewalEnabled;
                    const hidden = unavailable && subscriptionQuery.data.billingPeriod !== "annual";
                    if (hidden) return null;
                    return (
                      <button
                        key={period}
                        type="button"
                        className={
                          selectedRenewalPeriod === period ? "cm-button-primary" : "cm-button"
                        }
                        disabled={
                          renewalMutation.isPending ||
                          renewalOrder?.status === "pending_payment" ||
                          unavailable
                        }
                        title={unavailable ? "年付购买暂未开放，可切换为月付" : undefined}
                        onClick={() => {
                          if (period === selectedRenewalPeriod) return;
                          renewalMutation.reset();
                          renewalIdempotencyKey.current = crypto.randomUUID();
                          setActionError(null);
                          setRenewalBillingPeriod(period);
                        }}
                      >
                        {billingPeriodLabel(period)}
                      </button>
                    );
                  })}
                </div>
                {(!subscriptionQuery.data.trial ||
                  subscriptionQuery.data.trial.status === "converted") &&
                  subscriptionQuery.data.status !== "grandfathered" &&
                  subscriptionQuery.data.status !== "terminated" && (
                    <label
                      className={`flex items-center gap-2 text-xs text-zinc-400 transition-opacity ${
                        autoRenewMutation.isPending
                          ? "cursor-not-allowed opacity-60"
                          : "cursor-pointer"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 shrink-0"
                        checked={subscriptionQuery.data.autoRenew}
                        disabled={autoRenewMutation.isPending}
                        onChange={(event) => autoRenewMutation.mutate(event.target.checked)}
                      />
                      余额自动续费
                    </label>
                  )}
                {subscriptionQuery.data.status !== "terminated" && (
                  <button
                    type="button"
                    className="cm-button-primary"
                    disabled={
                      renewalMutation.isPending ||
                      subscriptionQuery.data.trial?.status === "provisioning" ||
                      capabilitiesQuery.data?.checkoutEnabled !== true ||
                      selectedRenewalUnavailable ||
                      selectedRenewalPriceCents === undefined
                    }
                    onClick={() => {
                      if (renewalOrder?.status === "pending_payment") setPaymentOpen(true);
                      else renewalMutation.mutate(selectedRenewalPeriod);
                    }}
                  >
                    {renewalMutation.isPending
                      ? "创建订单中…"
                      : capabilitiesQuery.data?.checkoutEnabled !== true
                        ? "续费暂未开放"
                        : selectedRenewalUnavailable
                          ? "年付暂未开放"
                          : renewalOrder?.status === "pending_payment"
                            ? "继续支付"
                            : subscriptionQuery.data.trial &&
                                subscriptionQuery.data.trial.status !== "converted"
                              ? `${billingPeriodLabel(selectedRenewalPeriod)}转为付费 ¥${((selectedRenewalPriceCents ?? 0) / 100).toFixed(2)}`
                              : `${billingPeriodLabel(selectedRenewalPeriod)}续费 ¥${((selectedRenewalPriceCents ?? 0) / 100).toFixed(2)}`}
                  </button>
                )}
              </section>
            )}

            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <InfoCard label="操作系统" value={m.imageLabel ?? m.imageId} />
              <InfoCard
                label="配置规格"
                value={`${planLabel(plan?.name ?? cachedPlanName ?? m.planId, {
                  code: plan?.code ?? plan?.name ?? cachedPlanName ?? m.planId,
                  cpu: m.cpu,
                  memoryMb: m.memoryMb,
                  diskGb: m.diskGb,
                })} · ${m.cpu} CPU · ${m.memoryMb / 1024} GB RAM · ${m.diskGb} GB DISK`}
              />
              <InfoCard label="电源状态" value={powerLabel(m.powerState)} />
              <InfoCard
                label="网络线路"
                meta={peakBandwidth}
                value={`${egressLineLabel(egressLinesQuery.data, m.egressLineId)}${
                  m.egressLineId !== m.egressLineAppliedId ? " · 切换中" : ""
                }`}
              />
              <InfoCard label="创建时间" value={new Date(m.createdAt).toLocaleString()} />
            </div>
            <div className="mt-3">
              <MetricsCard
                key={m.id}
                machineId={m.id}
                running={runtimeAvailable}
                preparing={[
                  "provisioning",
                  "starting",
                  "rebooting",
                  "restoring",
                  "rebuilding",
                ].includes(m.lifecycleStatus)}
                visible={tab === "overview"}
                loading={showingCachedDetail}
              />
            </div>
            <CliStorePanel
              machineId={m.id}
              available={isMachineRuntimeAvailable(m)}
              active={tab === "overview"}
            />
          </div>
        </KeepAlivePanel>
      )}
      {mountedTabs.has("ports") && (
        <KeepAlivePanel active={tab === "ports"}>
          <Suspense fallback={null}>
            {runtimeAvailable ? (
              <PortsPanel machineId={m.id} active={tab === "ports"} />
            ) : (
              <UnavailablePanel capability="检测端口" />
            )}
          </Suspense>
        </KeepAlivePanel>
      )}
      {mountedTabs.has("snapshots") && (
        <KeepAlivePanel active={tab === "snapshots"}>
          <Suspense fallback={null}>
            <SnapshotsPanel machineId={m.id} lifecycleStatus={m.lifecycleStatus} />
          </Suspense>
        </KeepAlivePanel>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* 当前电脑能力：终端、文件、端口与备份。 */}
      <div
        role="tablist"
        aria-label="电脑面板"
        className={MACHINE_TABLIST_CLASS_NAME}
        onKeyDown={(event) => {
          const index = tablistArrowTarget(event);
          if (index === null) return;
          event.preventDefault();
          const target = MACHINE_TABS[index];
          if (!target) return;
          focusTabAt(event.currentTarget, index);
          setTab(target.id);
        }}
      >
        {MACHINE_TABS.map((item) => (
          <TabButton
            key={item.id}
            icon={item.icon}
            active={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </TabButton>
        ))}
      </div>

      <div className="min-h-0 flex-1">{mainContent}</div>
      {rescueOpen && (
        <Suspense fallback={null}>
          <RescueTerminalDialog machineId={machineId} onClose={() => setRescueOpen(false)} />
        </Suspense>
      )}

      {renameOpen && (
        <RenameDialog
          key={m.name}
          open
          initialName={m.name}
          busy={renameMutation.isPending}
          error={renameError}
          title="重命名电脑"
          description="只修改显示名称，不会修改云端实例标识或影响电脑资源"
          fieldLabel="电脑名称"
          emptyError="请输入电脑名称"
          onOpenChange={(open) => {
            setRenameOpen(open);
            if (!open) setRenameError(null);
          }}
          onSubmit={(name) => renameMutation.mutate(name)}
        />
      )}

      <EgressLineDialog
        open={egressOpen}
        lines={egressLinesQuery.data ?? []}
        value={egressLineId}
        currentValue={m.egressLineId}
        busy={egressMutation.isPending}
        error={egressError}
        onValueChange={(value) => {
          setEgressLineId(value);
          setEgressError(null);
          // 线路变化代表新的操作意图，不能沿用上一份请求体的幂等键。
          egressIdempotencyKey.current = crypto.randomUUID();
        }}
        onCancel={() => {
          setEgressOpen(false);
          setEgressError(null);
        }}
        onConfirm={() => egressMutation.mutate(egressLineId)}
      />

      <ConfirmDialog
        open={confirmLifecycleAction !== null}
        title={confirmLifecycleAction === "stop" ? "停止电脑" : "重启电脑"}
        body={
          confirmLifecycleAction === "stop" ? (
            <>停止会中断所有项目的连接和电脑内正在运行的任务。确定停止电脑“{m.name}”吗？</>
          ) : (
            <>重启会暂时中断所有项目的连接。确定重启电脑“{m.name}”吗？</>
          )
        }
        confirmLabel={confirmLifecycleAction === "stop" ? "确认停止" : "确认重启"}
        busy={action.isPending}
        onCancel={() => setConfirmLifecycleAction(null)}
        onConfirm={() => confirmLifecycleAction && action.mutate(confirmLifecycleAction)}
      />

      <ConfirmDialog
        open={confirmRebuild}
        title="重装系统"
        body={
          <>
            <span className="font-medium text-red-400">重装系统会清空系统盘</span>
            ：电脑 <span className="font-medium text-zinc-200">{m.name}</span>{" "}
            将使用原镜像重新安装系统，系统盘上的所有数据都会丢失。电脑标识与配置保留。确定为“
            {m.name}”重装系统吗？
          </>
        }
        confirmLabel="确认重装"
        busy={rebuildMutation.isPending}
        onCancel={() => setConfirmRebuild(false)}
        onConfirm={() => rebuildMutation.mutate()}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="删除电脑"
        body={
          <>
            该操作会永久删除电脑、全部磁盘数据及其所有备份，
            <span className="text-red-400">无法恢复</span>
            。确定删除电脑“<span className="font-medium text-zinc-200">{m.name}</span>”吗？
            <MachineDeletionQuoteSummary
              quote={deletionQuote}
              pending={deletionQuoteMutation.isPending}
              error={deletionQuoteError}
            />
          </>
        }
        confirmLabel="确认删除"
        busy={deleteMutation.isPending}
        confirmDisabled={!deletionQuote || deletionQuoteMutation.isPending}
        onCancel={() => {
          setConfirmDelete(false);
          setDeletionQuote(null);
          setDeletionQuoteError(null);
        }}
        onConfirm={() => deleteMutation.mutate()}
      />
      <PaymentDialog
        open={paymentOpen}
        order={renewalOrder}
        allowBalance
        onOpenChange={(open) => {
          setPaymentOpen(open);
          if (!open) {
            setRenewalOrder((current) => (current?.status === "fulfilled" ? null : current));
          }
        }}
        onOrderChanged={setRenewalOrder}
        onCompleted={(order) => {
          setRenewalOrder(order);
          void queryClient.invalidateQueries({ queryKey: ["machine-subscription", machineId] });
          void queryClient.invalidateQueries({ queryKey: ["orders"] });
          void invalidate();
        }}
      />
    </div>
  );
}

function MachineDetailSkeleton({ tab }: { tab: Tab }) {
  return (
    <div role="status" aria-label="正在加载电脑详情" className="flex h-full flex-col">
      <span className="sr-only">正在加载电脑详情…</span>
      <div aria-hidden="true" className={MACHINE_TABLIST_CLASS_NAME}>
        {MACHINE_TABS.map((item) => (
          <span key={item.id} className={machineTabClassName(tab === item.id)}>
            {item.icon}
            {item.label}
          </span>
        ))}
      </div>
      {tab === "overview" && (
        <div aria-hidden="true" className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
          <div className="motion-safe:animate-pulse">
            <div className="cm-panel flex min-h-11 flex-wrap items-center gap-2 px-3 py-1.5">
              <span className="h-7 w-7 shrink-0 rounded bg-zinc-800/50" />
              <span className="h-3 w-28 rounded bg-zinc-800/50" />
              <span className="h-4 w-12 rounded bg-zinc-800/40" />
              <span className="h-3 w-32 rounded bg-zinc-800/40" />
              <div className="ml-auto flex gap-1.5">
                {[0, 1, 2].map((index) => (
                  <span key={index} className="h-7 w-12 rounded bg-zinc-800/40" />
                ))}
              </div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {["操作系统", "配置规格", "电源状态", "网络线路", "创建时间"].map((label) => (
                <div key={label} className="cm-panel p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
                      {label}
                    </div>
                    {label === "网络线路" && <span className="h-2 w-20 rounded bg-zinc-800/40" />}
                  </div>
                  <div className="mt-1 flex min-h-4 flex-wrap items-center gap-1.5">
                    <span className="h-3 w-2/3 rounded bg-zinc-800/50" />
                    {label === "配置规格" && <span className="h-3 w-1/2 rounded bg-zinc-800/40" />}
                  </div>
                </div>
              ))}
            </div>
            <div className="cm-panel mt-3 p-3">
              <div className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
                运行指标
              </div>
              <div className="mt-2.5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {["CPU", "内存", "硬盘", "网络"].map((label) => (
                  <div key={label}>
                    <div className="flex h-5 items-center justify-between gap-2">
                      <span className="text-xs text-zinc-500">{label}</span>
                      <span className="h-3 w-16 rounded bg-zinc-800/50" />
                    </div>
                    <div className="mt-1.5 h-1.5 rounded bg-zinc-800/50" />
                    <div className="mt-2 h-7 rounded bg-zinc-800/30" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function subscriptionStatusLabel(status: string): string {
  if (status === "grandfathered") return "开发期免费";
  if (status === "active") return "正常";
  if (status === "grace") return "宽限期";
  if (status === "suspended") return "已停机";
  return "已终止";
}

function billingPeriodLabel(period: BillingPeriod): string {
  return period === "annual" ? "年付" : "月付";
}

function billingPeriodDurationLabel(period: BillingPeriod): string {
  return period === "annual" ? "365天" : "30天";
}

function formatTrialRemaining(endsAt: string): string {
  const remainingMinutes = Math.max(0, Math.ceil((Date.parse(endsAt) - Date.now()) / 60_000));
  const days = Math.floor(remainingMinutes / (24 * 60));
  const hours = Math.floor((remainingMinutes % (24 * 60)) / 60);
  const minutes = remainingMinutes % 60;
  return days > 0
    ? `${days}天${hours}小时`
    : hours > 0
      ? `${hours}小时${minutes}分钟`
      : `${minutes}分钟`;
}

function egressLineLabel(lines: EgressLineOption[] | undefined, id: string): string {
  return lines?.find((line) => line.id === id)?.displayName ?? id;
}

function KeepAlivePanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div className={`absolute inset-0 ${active ? "block" : "hidden"}`} aria-hidden={!active}>
      {children}
    </div>
  );
}

function UnavailablePanel({ capability }: { capability: string }) {
  return (
    <div className="p-6 text-sm text-zinc-500">
      电脑未处于运行中状态，无法{capability}。请先启动电脑
    </div>
  );
}

function ActionButton(props: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={`cm-button ${props.className ?? ""}`}
    >
      {props.icon}
      {props.children}
    </button>
  );
}

function TabButton(props: {
  active: boolean;
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      onClick={props.onClick}
      aria-selected={props.active}
      tabIndex={props.active ? 0 : -1}
      className={machineTabClassName(props.active)}
    >
      {props.icon}
      {props.children}
    </button>
  );
}

function InfoCard({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta?: string | undefined;
}) {
  return (
    <div className="cm-panel p-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="text-[10px] font-medium tracking-wide text-zinc-500 uppercase">{label}</div>
        {meta && (
          <div className="shrink-0 whitespace-nowrap text-[10px] font-medium text-zinc-400">
            {meta}
          </div>
        )}
      </div>
      <div className="mt-1 break-all text-xs text-zinc-200">{value}</div>
    </div>
  );
}
