"use client";

import type { CommerceOrder } from "@cloud-machine/api-client";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CreditCard, RefreshCw, WalletCards } from "lucide-react";
import { useRouter, useSearchParams } from "../host";
import { useCallback, useEffect, useRef, useState } from "react";

import { PaymentDialog } from "../components/PaymentDialog";
import { api } from "../lib/api";
import { SETTINGS_PATHS, SETTINGS_RETURN_PARAM, settingsPathWithReturnTo } from "../lib/settings";
import { userErrorMessage } from "../lib/user-error";
import { toastSuccess } from "../stores/toast";

const RECHARGE_SUCCESS_DELAY_MS = 2_000;

const ORDER_STATUS_LABEL: Record<CommerceOrder["status"], string> = {
  pending_payment: "待支付",
  paid: "已支付",
  fulfilling: "处理中",
  fulfilled: "已完成",
  closed: "已关闭",
  refund_pending: "退款中",
  partially_refunded: "部分退款",
  refunded: "已退款",
  failed: "失败",
};

const ORDER_STATUS_TONE: Record<CommerceOrder["status"], string> = {
  pending_payment: "bg-amber-500/10 text-amber-500 ring-amber-500/20",
  paid: "bg-sky-500/10 text-sky-500 ring-sky-500/20",
  fulfilling: "bg-violet-500/10 text-violet-500 ring-violet-500/20",
  fulfilled: "bg-emerald-500/10 text-emerald-500 ring-emerald-500/20",
  closed: "bg-zinc-500/10 text-zinc-400 ring-zinc-500/20",
  refund_pending: "bg-orange-500/10 text-orange-500 ring-orange-500/20",
  partially_refunded: "bg-fuchsia-500/10 text-fuchsia-500 ring-fuchsia-500/20",
  refunded: "bg-cyan-500/10 text-cyan-500 ring-cyan-500/20",
  failed: "bg-red-500/10 text-red-500 ring-red-500/20",
};

const ORDER_TYPE_LABEL: Record<CommerceOrder["type"], string> = {
  recharge: "账户充值",
  machine_purchase: "购买编程机",
  machine_renewal: "电脑续费",
};

function yuan(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

function yuanInputToCents(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [yuanPart, decimalPart = ""] = normalized.split(".");
  const cents = Number(yuanPart) * 100 + Number(decimalPart.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <section>
      <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
      <p className="mt-1 text-xs leading-5 text-zinc-500">{description}</p>
    </section>
  );
}

function usePaymentCompletion(onRechargeFinished: () => void) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const handledOrderIds = useRef(new Set<string>());
  const [completedRechargeOrderId, setCompletedRechargeOrderId] = useState<string | null>(null);
  const onRechargeFinishedRef = useRef(onRechargeFinished);
  const walletPath = settingsPathWithReturnTo(
    SETTINGS_PATHS.wallet,
    searchParams?.get(SETTINGS_RETURN_PARAM),
  );

  useEffect(() => {
    onRechargeFinishedRef.current = onRechargeFinished;
  }, [onRechargeFinished]);

  useEffect(() => {
    if (!completedRechargeOrderId) return;
    const timer = window.setTimeout(() => {
      onRechargeFinishedRef.current();
      toastSuccess("充值成功，余额已到账");
      router.replace(walletPath);
    }, RECHARGE_SUCCESS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [completedRechargeOrderId, router, walletPath]);

  return useCallback(
    (order: CommerceOrder) => {
      if (handledOrderIds.current.has(order.id)) return;
      handledOrderIds.current.add(order.id);

      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["wallet"] });
      if (order.type !== "recharge") return;

      void queryClient.invalidateQueries({ queryKey: ["wallet-transactions"] });
      if (order.status !== "fulfilled") return;
      setCompletedRechargeOrderId(order.id);
    },
    [queryClient],
  );
}

export function WalletSettings() {
  const queryClient = useQueryClient();
  const capabilities = useQuery({
    queryKey: ["billing-capabilities"],
    queryFn: () => api.account.getBillingCapabilities(),
  });
  const wallet = useQuery({ queryKey: ["wallet"], queryFn: () => api.account.getWallet() });
  const transactions = useInfiniteQuery({
    queryKey: ["wallet-transactions"],
    initialPageParam: null as { before: string; beforeId: string } | null,
    queryFn: ({ pageParam }) =>
      api.account.getWalletTransactions({ limit: 50, ...(pageParam ?? {}) }),
    getNextPageParam: (page) =>
      page.nextBefore && page.nextBeforeId
        ? { before: page.nextBefore, beforeId: page.nextBeforeId }
        : undefined,
  });
  const [customAmount, setCustomAmount] = useState("");
  const [paymentOrder, setPaymentOrder] = useState<CommerceOrder | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const completePayment = usePaymentCompletion(() => {
    setPaymentOpen(false);
    setPaymentOrder(null);
  });
  const idempotencyKey = useRef(crypto.randomUUID());
  const createRecharge = useMutation({
    mutationFn: (amountCents: number) =>
      api.orders.createRecharge(amountCents, idempotencyKey.current),
    onSuccess: (order) => {
      setPaymentOrder(order);
      setPaymentOpen(true);
      idempotencyKey.current = crypto.randomUUID();
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
  });

  const customAmountCents = yuanInputToCents(customAmount);
  const minRechargeCents = capabilities.data?.rechargeMinCents ?? 100;
  const maxRechargeCents = capabilities.data?.rechargeMaxCents ?? 500_000;
  const customAmountValid =
    customAmountCents !== null &&
    customAmountCents >= minRechargeCents &&
    customAmountCents <= maxRechargeCents;
  const transactionItems = transactions.data?.pages.flatMap((page) => page.transactions) ?? [];
  const checkoutEnabled = capabilities.data?.checkoutEnabled === true;

  const submitCustom = () => {
    if (!customAmountValid || customAmountCents === null) return;
    createRecharge.mutate(customAmountCents);
  };

  if (capabilities.data && !capabilities.data.enabled) {
    return (
      <div className="space-y-5">
        <SectionHeading title="余额与充值" description="查看账户余额与充值记录" />
        <div className="cm-panel p-4 text-xs text-zinc-500">充值功能暂未开放</div>
      </div>
    );
  }

  if (capabilities.isError) {
    return (
      <div className="space-y-5">
        <SectionHeading title="余额与充值" description="查看账户余额与充值记录" />
        <div className="cm-panel p-4 text-xs text-red-400">
          {userErrorMessage(capabilities.error, "计费服务加载失败，请稍后重试")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SectionHeading title="余额与充值" description="微信充值到账户余额，用于购买或续费编程机" />

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="cm-panel p-4 sm:p-5">
          <div className="flex items-center gap-2 text-zinc-500">
            <WalletCards size={15} /> <span className="text-xs">可用余额</span>
          </div>
          <div className="mt-3 text-2xl font-semibold text-zinc-100">
            {wallet.isError ? "加载失败" : wallet.data ? yuan(wallet.data.availableCents) : "—"}
          </div>
          {wallet.data && wallet.data.frozenCents > 0 && (
            <p className="mt-2 text-[11px] text-zinc-500">冻结 {yuan(wallet.data.frozenCents)}</p>
          )}
        </div>
        <div className="cm-panel p-4 sm:p-5">
          <div className="flex items-center gap-2 text-zinc-500">
            <CreditCard size={15} /> <span className="text-xs">微信充值</span>
          </div>
          {!checkoutEnabled && (
            <p className="mt-3 text-xs text-amber-400">新充值暂时关闭，余额和历史记录不受影响</p>
          )}
          <div className="mt-3 grid grid-cols-4 gap-2">
            {(capabilities.data?.rechargePresetsCents ?? [5000, 10000, 20000, 50000]).map(
              (amount) => (
                <button
                  key={amount}
                  type="button"
                  className="cm-button justify-center"
                  disabled={createRecharge.isPending || !checkoutEnabled}
                  onClick={() => createRecharge.mutate(amount)}
                >
                  {yuan(amount)}
                </button>
              ),
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="block w-full max-w-48">
              <span className="mb-1 block text-[11px] text-zinc-500">自定义金额</span>
              <span className="relative block">
                <input
                  className="cm-input min-w-0 pr-8"
                  inputMode="decimal"
                  placeholder="1–5000"
                  value={customAmount}
                  onChange={(event) => setCustomAmount(event.target.value)}
                />
                <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-zinc-500">
                  元
                </span>
              </span>
            </label>
            <button
              type="button"
              className="cm-button-primary h-8 min-w-16 px-4"
              disabled={createRecharge.isPending || !customAmountValid || !checkoutEnabled}
              onClick={submitCustom}
            >
              充值
            </button>
          </div>
          {customAmount && !customAmountValid && (
            <p className="mt-2 text-[11px] text-amber-400">请输入 1–5000 元，最多两位小数</p>
          )}
          {createRecharge.isError && (
            <p className="mt-2 text-xs text-red-400">
              {userErrorMessage(createRecharge.error, "充值订单创建失败")}
            </p>
          )}
        </div>
      </section>

      <section className="cm-panel overflow-hidden">
        <div className="border-b border-zinc-800 px-4 py-3 text-xs font-medium text-zinc-200">
          余额明细
        </div>
        {transactions.isPending ? null : transactions.isError ? (
          <p className="p-4 text-xs text-red-400">
            {userErrorMessage(transactions.error, "余额明细加载失败")}
          </p>
        ) : transactionItems.length ? (
          <div>
            <div className="divide-y divide-zinc-800">
              {transactionItems.map((item) => (
                <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-zinc-200">{item.description}</p>
                    <p className="mt-1 text-[10px] text-zinc-600">
                      {new Date(item.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={`text-xs font-medium ${item.availableDeltaCents >= 0 ? "text-emerald-500" : "text-zinc-200"}`}
                    >
                      {item.availableDeltaCents >= 0 ? "+" : ""}
                      {yuan(item.availableDeltaCents)}
                    </p>
                    <p className="mt-1 text-[10px] text-zinc-600">
                      余额 {yuan(item.availableAfterCents)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            {transactions.hasNextPage && (
              <div className="border-t border-zinc-800 p-3 text-center">
                <button
                  type="button"
                  className="cm-button"
                  disabled={transactions.isFetchingNextPage}
                  onClick={() => void transactions.fetchNextPage()}
                >
                  {transactions.isFetchingNextPage ? "正在加载…" : "加载更多"}
                </button>
              </div>
            )}
          </div>
        ) : (
          <p className="p-4 text-xs text-zinc-500">暂无余额变动</p>
        )}
      </section>

      <PaymentDialog
        open={paymentOpen}
        order={paymentOrder}
        onOpenChange={setPaymentOpen}
        onOrderChanged={setPaymentOrder}
        onCompleted={(order) => {
          setPaymentOrder(order);
          completePayment(order);
        }}
      />
    </div>
  );
}

export function OrdersSettings() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const capabilitiesQuery = useQuery({
    queryKey: ["billing-capabilities"],
    queryFn: () => api.account.getBillingCapabilities(),
  });
  const orders = useInfiniteQuery({
    queryKey: ["orders"],
    initialPageParam: null as { before: string; beforeId: string } | null,
    queryFn: ({ pageParam }) => api.orders.list({ limit: 50, ...(pageParam ?? {}) }),
    getNextPageParam: (page) =>
      page.nextBefore && page.nextBeforeId
        ? { before: page.nextBefore, beforeId: page.nextBeforeId }
        : undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.orders.some((order) =>
          ["pending_payment", "paid", "fulfilling", "refund_pending"].includes(order.status),
        ),
      )
        ? 3000
        : false,
  });
  const orderItems = orders.data?.pages.flatMap((page) => page.orders) ?? [];
  const returnedOrderId = searchParams?.get("orderId") ?? null;
  const listedReturnedOrder = orderItems.find((order) => order.id === returnedOrderId);
  const returnedOrderQuery = useQuery({
    queryKey: ["orders", returnedOrderId],
    queryFn: () => api.orders.get(returnedOrderId!),
    enabled: Boolean(returnedOrderId && !listedReturnedOrder),
  });
  const returnedOrder = listedReturnedOrder ?? returnedOrderQuery.data ?? null;
  const [manualPaymentOrder, setManualPaymentOrder] = useState<CommerceOrder | null>(null);
  const [manualPaymentOpen, setManualPaymentOpen] = useState(false);
  const [dismissedReturnedOrderId, setDismissedReturnedOrderId] = useState<string | null>(null);
  const setPaymentOpen = (open: boolean) => {
    setManualPaymentOpen(open);
    if (!open && returnedOrderId) setDismissedReturnedOrderId(returnedOrderId);
    if (!open) setManualPaymentOrder(null);
  };
  const completePayment = usePaymentCompletion(() => setPaymentOpen(false));
  const closeOrder = useMutation({
    mutationFn: (orderId: string) => api.orders.close(orderId, crypto.randomUUID()),
    onSuccess: (closed) => {
      setManualPaymentOpen(false);
      setManualPaymentOrder(null);
      if (returnedOrderId === closed.id) setDismissedReturnedOrderId(closed.id);
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
  });
  const returnedRechargeSettling =
    returnedOrder?.type === "recharge" &&
    ["paid", "fulfilling", "fulfilled"].includes(returnedOrder.status);
  const showReturnedOrder = Boolean(
    returnedOrder &&
    returnedOrder.id !== dismissedReturnedOrderId &&
    ((capabilitiesQuery.data?.checkoutEnabled === true &&
      returnedOrder.status === "pending_payment") ||
      returnedRechargeSettling),
  );
  const paymentOrder = manualPaymentOrder ?? (showReturnedOrder ? returnedOrder : null);
  const paymentOpen = manualPaymentOpen || Boolean(showReturnedOrder);

  return (
    <div className="space-y-5">
      <SectionHeading title="订单" description="查看充值、购机和续费订单及其处理状态" />
      <section className="cm-panel overflow-hidden">
        <div className="flex items-center border-b border-zinc-800 px-4 py-3">
          <span className="text-xs font-medium text-zinc-200">全部订单</span>
          <button
            type="button"
            className="cm-icon-button ml-auto"
            title="刷新订单"
            onClick={() => void orders.refetch()}
          >
            <RefreshCw size={13} className={orders.isFetching ? "animate-spin" : ""} />
          </button>
        </div>
        {closeOrder.isError && (
          <p className="border-b border-zinc-800 px-4 py-2 text-xs text-red-400">
            {userErrorMessage(closeOrder.error, "订单取消失败，请刷新后重试")}
          </p>
        )}
        {orders.isPending ? null : orders.isError ? (
          <p className="p-4 text-xs text-red-400">
            {userErrorMessage(orders.error, "订单加载失败")}
          </p>
        ) : orderItems.length === 0 ? (
          <p className="p-4 text-xs text-zinc-500">暂无订单</p>
        ) : (
          <div className="divide-y divide-zinc-800">
            {orderItems.map((order) => (
              <article key={order.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 basis-56">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-medium text-zinc-200">
                      {order.description}
                    </span>
                    <span
                      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] ring-1 ring-inset ${ORDER_STATUS_TONE[order.status]}`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                      {ORDER_STATUS_LABEL[order.status]}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] text-zinc-600">
                    {ORDER_TYPE_LABEL[order.type]} · {order.orderNo} ·{" "}
                    {new Date(order.createdAt).toLocaleString()}
                  </p>
                </div>
                <span className="text-xs font-medium text-zinc-200">{yuan(order.amountCents)}</span>
                {order.status === "pending_payment" && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="cm-button"
                      disabled={closeOrder.isPending}
                      onClick={() => closeOrder.mutate(order.id)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="cm-button-primary"
                      disabled={capabilitiesQuery.data?.checkoutEnabled !== true}
                      onClick={() => {
                        setManualPaymentOrder(order);
                        setManualPaymentOpen(true);
                      }}
                    >
                      支付
                    </button>
                  </div>
                )}
                {order.machineId && ["fulfilling", "fulfilled"].includes(order.status) && (
                  <button
                    type="button"
                    className="cm-button"
                    onClick={() => router.push(`/machines/${order.machineId}`)}
                  >
                    查看电脑
                  </button>
                )}
              </article>
            ))}
            {orders.hasNextPage && (
              <div className="p-3 text-center">
                <button
                  type="button"
                  className="cm-button"
                  disabled={orders.isFetchingNextPage}
                  onClick={() => void orders.fetchNextPage()}
                >
                  {orders.isFetchingNextPage ? "正在加载…" : "加载更多"}
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      <PaymentDialog
        open={paymentOpen}
        order={paymentOrder}
        allowBalance={paymentOrder?.type !== "recharge"}
        onOpenChange={setPaymentOpen}
        onOrderChanged={setManualPaymentOrder}
        onCompleted={(order) => {
          setManualPaymentOrder(order);
          completePayment(order);
        }}
      />
    </div>
  );
}

export function NotificationsSettings() {
  const queryClient = useQueryClient();
  const notifications = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.account.getNotifications(),
    refetchInterval: 30_000,
  });
  const markRead = useMutation({
    mutationFn: (id: string) => api.account.markNotificationRead(id),
    onSuccess: () =>
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["notifications"] }),
        queryClient.invalidateQueries({ queryKey: ["notification-summary"] }),
      ]),
  });
  return (
    <div className="space-y-5">
      <SectionHeading title="消息" description="账户功能、支付、续费、欠费停机与退款状态通知" />
      <section className="cm-panel overflow-hidden">
        {notifications.isPending ? null : notifications.isError ? (
          <p className="p-4 text-xs text-red-400">
            {userErrorMessage(notifications.error, "消息加载失败")}
          </p>
        ) : notifications.data?.length ? (
          <div className="divide-y divide-zinc-800">
            {notifications.data.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-zinc-800/60 ${item.readAt ? "opacity-70" : ""}`}
                onClick={() => !item.readAt && markRead.mutate(item.id)}
              >
                <Bell
                  size={14}
                  className={item.readAt ? "text-zinc-600" : "text-[var(--cm-accent)]"}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-zinc-200">{item.title}</span>
                  <span className="mt-1 block whitespace-pre-wrap text-xs leading-5 text-zinc-500">
                    {item.body}
                  </span>
                  <span className="mt-1 block text-[10px] text-zinc-600">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </span>
                {!item.readAt && (
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-[var(--cm-accent)]" />
                )}
              </button>
            ))}
          </div>
        ) : (
          <p className="p-4 text-xs text-zinc-500">暂无消息</p>
        )}
      </section>
    </div>
  );
}
