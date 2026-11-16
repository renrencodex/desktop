/**
 * /machines/new：创建电脑表单（名称 + plan 卡片 + imageId）。
 * Idempotency-Key 自动生成（crypto.randomUUID，Rule 6 幂等写）；
 * 重复点击/重试同一表单提交不会产生重复电脑。创建成功跳真实进度页。
 */
"use client";

import {
  isApiError,
  parseMachinePurchaseSelection,
  type BillingPeriod,
  type CommerceOrder,
} from "@cloud-machine/api-client";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Cpu,
  Gauge,
  Globe2,
  HardDrive,
  MemoryStick,
  Monitor,
  Plus,
  Server,
} from "lucide-react";
import { useRouter, useSearchParams } from "../host";
import { useRef, useState, type FormEvent } from "react";
import { RECOMMENDED_MACHINE_IMAGE_ID } from "@cloud-machine/client-contracts";

import { MachinePlanSelect, reconcileMachinePlanId } from "../components/MachinePlanSelect";
import { MachineImageSelect } from "../components/MachineImageSelect";
import { PaymentDialog } from "../components/PaymentDialog";
import { api } from "../lib/api";
import { peakBandwidthLabel } from "../lib/display-labels";
import { userErrorMessage } from "../lib/user-error";
import { useAuthStore } from "../stores/auth";

const TRIAL_PAID_FALLBACK_CODES = new Set([
  "TRIAL_UNAVAILABLE",
  "TRIAL_NOT_ELIGIBLE",
  "TRIAL_ELIGIBILITY_EXPIRED",
  "TRIAL_CAMPAIGN_PAUSED",
  "TRIAL_DAILY_CAPACITY_REACHED",
  "TRIAL_CAPACITY_REACHED",
  "TRIAL_PLAN_UNAVAILABLE",
]);

export function NewMachinePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionUser = useAuthStore((state) => state.user);
  const accountId = sessionUser?.id;
  const requestedPurchase = parseMachinePurchaseSelection(searchParams?.toString() ?? "");
  const currentUserQuery = useQuery({
    queryKey: ["current-user", accountId],
    queryFn: () => api.auth.me(),
    enabled: Boolean(accountId),
    placeholderData: sessionUser ?? undefined,
    staleTime: 60_000,
  });
  const plansQuery = useQuery({ queryKey: ["plans"], queryFn: () => api.plans.list() });
  const capabilitiesQuery = useQuery({
    queryKey: ["billing-capabilities"],
    queryFn: () => api.account.getBillingCapabilities(),
  });
  const trialQuery = useQuery({
    queryKey: ["account-trial"],
    queryFn: () => api.account.getTrial(),
  });
  const egressLinesQuery = useQuery({
    queryKey: ["egress-lines"],
    queryFn: () => api.machines.listEgressLines(),
  });

  const [name, setName] = useState("");
  const [planId, setPlanId] = useState("");
  const [imageId, setImageId] = useState(RECOMMENDED_MACHINE_IMAGE_ID);
  const [egressLineId, setEgressLineId] = useState("");
  const [paymentOrder, setPaymentOrder] = useState<CommerceOrder | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [purchaseMode, setPurchaseMode] = useState<"trial" | "paid">(
    requestedPurchase ? "paid" : "trial",
  );
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>(
    requestedPurchase?.billingPeriod ?? "monthly",
  );
  const [trialResultNeedsReconciliation, setTrialResultNeedsReconciliation] = useState(false);
  const availablePlans = plansQuery.data ?? [];
  const requestedPlanId =
    availablePlans.find((plan) => plan.code === requestedPurchase?.planCode)?.id ?? "";
  const effectivePlanId = reconcileMachinePlanId(availablePlans, planId || requestedPlanId);
  const requestedPlanUnavailable =
    plansQuery.isSuccess && requestedPurchase !== null && requestedPlanId === "";
  const supportedBillingPeriods: BillingPeriod[] = capabilitiesQuery.data?.billingPeriods ?? [
    "monthly",
  ];
  const effectiveBillingPeriod =
    capabilitiesQuery.isSuccess && !supportedBillingPeriods.includes(billingPeriod)
      ? (supportedBillingPeriods[0] ?? "monthly")
      : billingPeriod;
  const requestedBillingPeriodUnavailable =
    capabilitiesQuery.isSuccess &&
    requestedPurchase?.billingPeriod === "annual" &&
    !supportedBillingPeriods.includes("annual");
  const imagesQuery = useQuery({
    queryKey: ["machine-images", effectivePlanId],
    queryFn: () => api.machineImages.list(effectivePlanId),
    enabled: Boolean(effectivePlanId),
    // 切换规格时保留上一份镜像列表，避免区域卸载/重挂载造成的闪烁。
    placeholderData: keepPreviousData,
  });
  const availableImages = imagesQuery.data ?? [];
  const effectiveImageId = availableImages.some((image) => image.id === imageId)
    ? imageId
    : (availableImages[0]?.id ?? "");
  const availableEgressLines = egressLinesQuery.data ?? [];
  const effectiveEgressLineId = availableEgressLines.some((line) => line.id === egressLineId)
    ? egressLineId
    : (availableEgressLines.find((line) => line.isDefault)?.id ??
      availableEgressLines[0]?.id ??
      "");
  const trialPlanIds = trialQuery.data?.canClaim
    ? trialQuery.data.plans.map((plan) => plan.id)
    : [];
  const selectedPlanSupportsTrial = trialPlanIds.includes(effectivePlanId);
  const showTrialPurchaseMode = selectedPlanSupportsTrial || trialResultNeedsReconciliation;
  const selectedUsesTrial =
    trialResultNeedsReconciliation || (selectedPlanSupportsTrial && purchaseMode === "trial");
  // 每次表单提交失败重试沿用同一 key；成功或手动重置后换新。
  const idempotencyKey = useRef(crypto.randomUUID());

  const mutation = useMutation({
    mutationFn: async () => {
      const input = {
        name,
        planId: effectivePlanId,
        imageId: effectiveImageId,
        egressLineId: effectiveEgressLineId,
      };
      if (selectedUsesTrial) {
        return {
          kind: "machine" as const,
          machine: await api.account.claimTrial(input, idempotencyKey.current),
        };
      }
      if (capabilitiesQuery.data?.checkoutEnabled) {
        return {
          kind: "order" as const,
          order: await api.orders.createMachine(
            { ...input, billingPeriod: effectiveBillingPeriod },
            idempotencyKey.current,
          ),
        };
      }
      if (!capabilitiesQuery.data?.legacyFreeMachineCreationEnabled) {
        throw new Error("购机服务暂未开放");
      }
      return {
        kind: "machine" as const,
        machine: await api.machines.create(input, { idempotencyKey: idempotencyKey.current }),
      };
    },
    onSuccess: (result) => {
      if (result.kind === "order") {
        setPaymentOrder(result.order);
        setPaymentOpen(true);
        return;
      }
      idempotencyKey.current = crypto.randomUUID();
      router.push(`/machines/${result.machine.id}/provisioning`);
    },
    onError: (error) => {
      if (!selectedUsesTrial) return;
      if (isApiError(error) && TRIAL_PAID_FALLBACK_CODES.has(error.code)) {
        setPurchaseMode("paid");
        setTrialResultNeedsReconciliation(false);
        idempotencyKey.current = crypto.randomUUID();
        return;
      }
      if (
        !isApiError(error) ||
        error.code === "TRIAL_ALREADY_USED" ||
        error.code === "IDEMPOTENCY_CONFLICT"
      ) {
        setTrialResultNeedsReconciliation(true);
      }
    },
  });
  const cancelOrderMutation = useMutation({
    mutationFn: () => api.orders.close(paymentOrder!.id, crypto.randomUUID()),
    onSuccess: () => {
      setPaymentOrder(null);
      setPaymentOpen(false);
      idempotencyKey.current = crypto.randomUUID();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (paymentOrder) {
      setPaymentOpen(true);
      return;
    }
    mutation.mutate();
  };

  const selectedPlan = availablePlans.find((plan) => plan.id === effectivePlanId);
  const peakBandwidth = peakBandwidthLabel(currentUserQuery.data?.machinePublicBandwidthMbps);
  const paymentOrderTerminal =
    paymentOrder !== null && ["closed", "failed", "refunded"].includes(paymentOrder.status);

  const resetPaymentOrder = () => {
    setPaymentOrder(null);
    setPaymentOpen(false);
    mutation.reset();
    idempotencyKey.current = crypto.randomUUID();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="cm-toolbar shrink-0">
        <button
          type="button"
          className="cm-icon-button"
          onClick={() => router.push("/machines")}
          title="返回电脑列表"
        >
          <ArrowLeft size={14} />
        </button>
        <Monitor size={14} className="text-zinc-500" />
        <h1 className="text-xs font-medium text-zinc-200">新建电脑</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-5">
        <div className="mx-auto grid max-w-4xl gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <form onSubmit={onSubmit} className="cm-panel overflow-hidden">
            <div className="border-b border-zinc-800 px-4 py-3">
              <h2 className="text-sm font-medium text-zinc-200">电脑配置</h2>
              <p className="mt-1 text-xs text-zinc-500">
                提交后会进入创建进度页；终端和文件能力验证完成后自动打开项目
              </p>
            </div>
            <fieldset
              className="space-y-4 p-4"
              disabled={paymentOrder !== null || trialResultNeedsReconciliation}
            >
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-medium text-zinc-500">电脑名称</span>
                <input
                  autoFocus
                  required
                  maxLength={100}
                  placeholder="例如 ubuntu-dev-01"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="cm-input"
                />
              </label>

              {showTrialPurchaseMode && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-2">
                  <span className="mb-1.5 block text-[10px] font-medium text-zinc-500">
                    创建方式
                  </span>
                  <div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup">
                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-zinc-800 px-2.5 py-2 text-xs text-zinc-300 has-[:checked]:border-cyan-700 has-[:checked]:bg-cyan-950/30">
                      <input
                        type="radio"
                        name="purchase-mode"
                        value="trial"
                        checked={purchaseMode === "trial"}
                        onChange={() => {
                          setPurchaseMode("trial");
                          mutation.reset();
                          idempotencyKey.current = crypto.randomUUID();
                        }}
                        className="mt-0.5 accent-cyan-500"
                      />
                      <span>
                        <strong className="block font-medium">使用免费试用</strong>
                        <small className="mt-0.5 block text-[10px] text-zinc-500">
                          免费 {trialQuery.data?.durationDays ?? 3} 天，到期前可转付费
                        </small>
                      </span>
                    </label>
                    <label
                      className={`flex items-start gap-2 rounded-md border border-zinc-800 px-2.5 py-2 text-xs text-zinc-300 has-[:checked]:border-cyan-700 has-[:checked]:bg-cyan-950/30 ${trialResultNeedsReconciliation ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                    >
                      <input
                        type="radio"
                        name="purchase-mode"
                        value="paid"
                        checked={purchaseMode === "paid"}
                        disabled={trialResultNeedsReconciliation}
                        onChange={() => {
                          setPurchaseMode("paid");
                          mutation.reset();
                          idempotencyKey.current = crypto.randomUUID();
                        }}
                        className="mt-0.5 accent-cyan-500"
                      />
                      <span>
                        <strong className="block font-medium">直接付费购买</strong>
                        <small className="mt-0.5 block text-[10px] text-zinc-500">
                          不使用本次试用权益
                        </small>
                      </span>
                    </label>
                  </div>
                  {trialResultNeedsReconciliation && (
                    <p className="mt-2 text-[10px] leading-4 text-amber-400">
                      上次领取结果尚未确认。请保持试用方式重试，或刷新页面确认电脑状态后再购买。
                    </p>
                  )}
                </div>
              )}

              {!selectedUsesTrial && capabilitiesQuery.data?.billingPeriods?.includes("annual") && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-2">
                  <span className="mb-1.5 block text-[10px] font-medium text-zinc-500">
                    付费周期
                  </span>
                  <div className="grid grid-cols-2 gap-1.5" role="radiogroup">
                    {(["monthly", "annual"] as const).map((period) => (
                      <label
                        key={period}
                        className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-800 px-2.5 py-2 text-xs text-zinc-300 has-[:checked]:border-cyan-700 has-[:checked]:bg-cyan-950/30"
                      >
                        <input
                          type="radio"
                          name="billing-period"
                          value={period}
                          checked={effectiveBillingPeriod === period}
                          onChange={() => {
                            setBillingPeriod(period);
                            mutation.reset();
                            idempotencyKey.current = crypto.randomUUID();
                          }}
                          className="accent-cyan-500"
                        />
                        {period === "annual" ? "按年付费(365天)" : "按月付费(30天)"}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {!selectedUsesTrial && requestedBillingPeriodUnavailable && (
                <p className="rounded border px-3 py-2 text-xs cm-banner-warning">
                  所选年付周期当前不可用，已切换为按月付费(30天)。
                </p>
              )}

              <div>
                <span
                  id="machine-plan-label"
                  className="mb-1.5 block text-[11px] font-medium text-zinc-500"
                >
                  计算规格
                </span>
                {plansQuery.isError && (
                  <p className="text-xs text-red-400">
                    加载套餐失败：{userErrorMessage(plansQuery.error, "未知错误")}
                  </p>
                )}
                {plansQuery.data && plansQuery.data.length === 0 && (
                  <p className="text-xs text-zinc-500">暂无可用套餐，请联系平台管理员</p>
                )}
                {plansQuery.data && plansQuery.data.length > 0 && (
                  <>
                    {requestedPlanUnavailable && (
                      <p className="mb-2 rounded border px-3 py-2 text-xs cm-banner-warning">
                        所选配置当前不可用，已为你选择其他配置。
                      </p>
                    )}
                    <MachinePlanSelect
                      plans={plansQuery.data}
                      value={effectivePlanId}
                      onValueChange={setPlanId}
                      trialPlanIds={trialPlanIds}
                      trialDays={trialQuery.data?.durationDays}
                      billingPeriod={selectedUsesTrial ? "monthly" : effectiveBillingPeriod}
                      peakBandwidthLabel={peakBandwidth}
                    />
                  </>
                )}
              </div>

              <label className="block">
                <span className="mb-1.5 block text-[11px] font-medium text-zinc-500">网络线路</span>
                <select
                  className="cm-input"
                  value={effectiveEgressLineId}
                  onChange={(event) => setEgressLineId(event.target.value)}
                  disabled={egressLinesQuery.isPending || egressLinesQuery.isError}
                >
                  {availableEgressLines.map((line) => (
                    <option key={line.id} value={line.id}>
                      {line.displayName}
                      {line.isDefault ? "（默认）" : ""}
                    </option>
                  ))}
                </select>
                {egressLinesQuery.isError && (
                  <p className="mt-1 text-[11px] text-red-400">网络线路加载失败，请重试</p>
                )}
              </label>

              <div>
                <span
                  id="machine-image-label"
                  className="mb-1.5 block text-[11px] font-medium text-zinc-500"
                >
                  操作系统
                </span>
                {imagesQuery.isError && (
                  <p className="text-xs text-red-400">操作系统加载失败，请重试</p>
                )}
                {imagesQuery.isSuccess && availableImages.length === 0 && (
                  <p className="text-xs text-zinc-500">当前规格暂无可用操作系统</p>
                )}
                {availableImages.length > 0 && (
                  <MachineImageSelect
                    images={availableImages}
                    value={effectiveImageId}
                    onValueChange={setImageId}
                  />
                )}
              </div>

              {mutation.isError && (
                <p className="rounded border px-3 py-2 text-xs cm-banner-danger">
                  {userErrorMessage(mutation.error, "创建失败，请重试")}
                </p>
              )}
              {capabilitiesQuery.isError && (
                <p className="rounded border px-3 py-2 text-xs cm-banner-danger">
                  {userErrorMessage(capabilitiesQuery.error, "计费配置加载失败，请稍后重试")}
                </p>
              )}
              {trialQuery.isError && (
                <p className="rounded border px-3 py-2 text-xs cm-banner-warning">
                  试用资格暂时无法加载，仍可正常购买电脑
                </p>
              )}
            </fieldset>
            {paymentOrder && (
              <div className="mx-4 mb-4 rounded-[8px] border px-3 py-2 cm-banner-warning">
                <p className="text-xs">
                  订单 {paymentOrder.orderNo}
                  {paymentOrder.status === "pending_payment"
                    ? " 等待支付，配置已锁定"
                    : paymentOrderTerminal
                      ? paymentOrder.status === "refunded"
                        ? " 已退款，可以重新配置"
                        : " 未完成，可以重新配置"
                      : " 正在处理，配置已锁定"}
                </p>
                {paymentOrder.status === "pending_payment" && (
                  <button
                    type="button"
                    className="mt-2 text-[11px] underline underline-offset-2"
                    disabled={cancelOrderMutation.isPending}
                    onClick={() => cancelOrderMutation.mutate()}
                  >
                    {cancelOrderMutation.isPending ? "正在取消…" : "取消订单并重新配置"}
                  </button>
                )}
                {paymentOrderTerminal && (
                  <button
                    type="button"
                    className="mt-2 text-[11px] underline underline-offset-2"
                    onClick={resetPaymentOrder}
                  >
                    重新配置
                  </button>
                )}
                {cancelOrderMutation.isError && (
                  <p className="mt-2 text-[11px] text-red-400">
                    {userErrorMessage(cancelOrderMutation.error, "订单取消失败，请稍后重试")}
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 border-t border-zinc-800 bg-zinc-950/40 px-4 py-3">
              <button type="button" onClick={() => router.push("/machines")} className="cm-button">
                取消
              </button>
              <button
                type="submit"
                disabled={
                  mutation.isPending ||
                  trialQuery.isPending ||
                  (!selectedUsesTrial && capabilitiesQuery.isPending) ||
                  (!selectedUsesTrial && capabilitiesQuery.isError) ||
                  (!selectedUsesTrial &&
                    capabilitiesQuery.isSuccess &&
                    !capabilitiesQuery.data.checkoutEnabled &&
                    !capabilitiesQuery.data.legacyFreeMachineCreationEnabled) ||
                  imagesQuery.isPending ||
                  imagesQuery.isPlaceholderData ||
                  imagesQuery.isError ||
                  egressLinesQuery.isPending ||
                  egressLinesQuery.isError ||
                  !effectivePlanId ||
                  !effectiveImageId ||
                  !effectiveEgressLineId
                }
                className="cm-button-primary"
              >
                <Plus size={13} />
                {mutation.isPending
                  ? "正在提交…"
                  : imagesQuery.isPlaceholderData
                    ? "正在更新操作系统…"
                    : paymentOrder
                      ? "继续支付"
                      : selectedUsesTrial
                        ? `免费试用${trialQuery.data?.durationDays ?? 3}天`
                        : capabilitiesQuery.data?.checkoutEnabled
                          ? "创建订单"
                          : capabilitiesQuery.data?.legacyFreeMachineCreationEnabled
                            ? "创建电脑"
                            : "购机暂未开放"}
              </button>
            </div>
          </form>

          <aside className="cm-panel h-fit overflow-hidden">
            <div className="border-b border-zinc-800 px-3 py-2 text-[11px] font-medium text-zinc-500">
              配置摘要
            </div>
            <div className="space-y-3 p-3">
              <Spec icon={<Server size={13} />} label="名称" value={name.trim() || "尚未填写"} />
              <Spec
                icon={<Cpu size={13} />}
                label="处理器"
                value={selectedPlan ? `${selectedPlan.cpu} CPU` : "—"}
              />
              <Spec
                icon={<MemoryStick size={13} />}
                label="内存"
                value={selectedPlan ? `${(selectedPlan.memoryMb / 1024).toFixed(0)} GB` : "—"}
              />
              <Spec
                icon={<HardDrive size={13} />}
                label="系统盘"
                value={selectedPlan ? `${selectedPlan.diskGb} GB` : "—"}
              />
              <Spec
                icon={<Globe2 size={13} />}
                label="网络线路"
                value={
                  availableEgressLines.find((line) => line.id === effectiveEgressLineId)
                    ?.displayName ?? "—"
                }
              />
              <Spec icon={<Gauge size={13} />} label="网络带宽" value={peakBandwidth ?? "—"} />
              <Spec
                icon={<span className="text-xs">¥</span>}
                label={selectedUsesTrial ? "试用与转付费" : "价格"}
                value={
                  selectedUsesTrial
                    ? `前${trialQuery.data?.durationDays ?? 3}天免费，转付费 ¥${((selectedPlan?.monthlyPriceCents ?? 0) / 100).toFixed(2)}/30天`
                    : selectedPlan
                      ? `¥${((effectiveBillingPeriod === "annual" ? selectedPlan.annualPriceCents : selectedPlan.monthlyPriceCents) / 100).toFixed(2)}/${effectiveBillingPeriod === "annual" ? "365天" : "30天"}`
                      : "—"
                }
              />
            </div>
          </aside>
        </div>
      </div>

      <PaymentDialog
        open={paymentOpen}
        order={paymentOrder}
        allowBalance
        onOpenChange={setPaymentOpen}
        onOrderChanged={(order) => {
          setPaymentOrder(order);
          if (order.status === "closed") {
            setPaymentOpen(false);
            setPaymentOrder(null);
            idempotencyKey.current = crypto.randomUUID();
          }
        }}
        onCompleted={(order) => {
          setPaymentOrder(order);
          if (order.machineId) {
            idempotencyKey.current = crypto.randomUUID();
            router.push(`/machines/${order.machineId}/provisioning`);
          }
        }}
      />
    </div>
  );
}

function Spec({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-zinc-600">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] text-zinc-600">{label}</span>
        <span className="block truncate text-xs text-zinc-300">{value}</span>
      </span>
    </div>
  );
}
