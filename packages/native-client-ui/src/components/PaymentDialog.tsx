"use client";

import type { CommerceOrder, PaymentAction, PaymentResponse } from "@cloud-machine/api-client";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, LoaderCircle, MessageCircle, QrCode, WalletCards } from "lucide-react";
import { toDataURL } from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";

import { useClientHost } from "../host";
import { api } from "../lib/api";
import { userErrorMessage } from "../lib/user-error";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface PaymentDialogProps {
  open: boolean;
  order: CommerceOrder | null;
  allowBalance?: boolean;
  onOpenChange(open: boolean): void;
  onOrderChanged?(order: CommerceOrder): void;
  onCompleted(order: CommerceOrder): void;
}

const RENEWAL_SUCCESS_DELAY_MS = 2_000;

function yuan(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

function preferredWechatScene(): "native" | "h5" | "jsapi" {
  const ua = navigator.userAgent;
  if (/MicroMessenger/i.test(ua)) return "jsapi";
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return "h5";
  return "native";
}

function paymentReachedBusiness(order: CommerceOrder): boolean {
  if (order.type === "machine_purchase") {
    return order.machineId !== null && ["fulfilling", "fulfilled"].includes(order.status);
  }
  return order.status === "fulfilled";
}

function paymentReachedTerminalFailure(order: CommerceOrder): boolean {
  return order.status === "closed" || order.status === "failed" || order.status === "refunded";
}

function shouldApplyOrderSnapshot(
  current: CommerceOrder | null,
  candidate: CommerceOrder,
): boolean {
  if (!current || current.id !== candidate.id) return true;

  const currentUpdatedAt = Date.parse(current.updatedAt);
  const candidateUpdatedAt = Date.parse(candidate.updatedAt);
  if (Number.isFinite(currentUpdatedAt) && Number.isFinite(candidateUpdatedAt)) {
    if (candidateUpdatedAt < currentUpdatedAt) return false;
    if (candidateUpdatedAt > currentUpdatedAt) return true;
  }

  return !paymentReachedBusiness(current) || paymentReachedBusiness(candidate);
}

async function invokeWechatJsapi(action: Extract<PaymentAction, { kind: "jsapi" }>) {
  type Bridge = {
    invoke(
      name: string,
      payload: Record<string, string>,
      callback: (result: { err_msg?: string }) => void,
    ): void;
  };
  const getBridge = () => (window as unknown as { WeixinJSBridge?: Bridge }).WeixinJSBridge ?? null;
  const bridge =
    getBridge() ??
    (await new Promise<Bridge>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("微信支付组件加载超时")), 10_000);
      document.addEventListener(
        "WeixinJSBridgeReady",
        () => {
          window.clearTimeout(timer);
          const ready = getBridge();
          if (ready) resolve(ready);
          else reject(new Error("微信支付组件不可用"));
        },
        { once: true },
      );
    }));
  await new Promise<void>((resolve, reject) => {
    bridge.invoke(
      "getBrandWCPayRequest",
      {
        appId: action.appId,
        timeStamp: action.timeStamp,
        nonceStr: action.nonceStr,
        package: action.package,
        signType: action.signType,
        paySign: action.paySign,
      },
      (result) => {
        if (result.err_msg === "get_brand_wcpay_request:ok") resolve();
        else reject(new Error("支付未完成"));
      },
    );
  });
}

function PaymentDialogSession(props: PaymentDialogProps) {
  const { platform } = useClientHost();
  const walletQuery = useQuery({
    queryKey: ["wallet"],
    queryFn: () => api.account.getWallet(),
    enabled: props.open && Boolean(props.allowBalance),
  });
  const [currentOrder, setCurrentOrder] = useState<CommerceOrder | null>(props.order);
  const [action, setAction] = useState<PaymentAction | null>(null);
  const [qrImage, setQrImage] = useState<{ codeUrl: string; dataUrl: string } | null>(null);
  const [busy, setBusy] = useState<"balance" | "wechat" | "sync" | "close" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completedOrderId = useRef<string | null>(null);
  const latestOrder = useRef<CommerceOrder | null>(props.order);
  const paymentKey = useRef(crypto.randomUUID());
  const callbacks = useRef({
    onOpenChange: props.onOpenChange,
    onCompleted: props.onCompleted,
    onOrderChanged: props.onOrderChanged,
  });

  useEffect(() => {
    callbacks.current = {
      onOpenChange: props.onOpenChange,
      onCompleted: props.onCompleted,
      onOrderChanged: props.onOrderChanged,
    };
  }, [props.onCompleted, props.onOpenChange, props.onOrderChanged]);

  useEffect(() => {
    if (action?.kind !== "native_qr") return;
    let active = true;
    void toDataURL(action.codeUrl, { width: 224, margin: 1, errorCorrectionLevel: "M" })
      .then((dataUrl) => active && setQrImage({ codeUrl: action.codeUrl, dataUrl }))
      .catch(() => active && setError("支付二维码生成失败，请重试"));
    return () => {
      active = false;
    };
  }, [action]);

  const applyOrderSnapshot = useCallback((order: CommerceOrder, notifyParent: boolean) => {
    if (!shouldApplyOrderSnapshot(latestOrder.current, order)) return false;

    latestOrder.current = order;
    setCurrentOrder(order);
    if (notifyParent) callbacks.current.onOrderChanged?.(order);
    if (paymentReachedBusiness(order) && completedOrderId.current !== order.id) {
      completedOrderId.current = order.id;
      callbacks.current.onCompleted(order);
    }
    return true;
  }, []);

  const completeIfReady = useCallback(
    (order: CommerceOrder) => applyOrderSnapshot(order, true),
    [applyOrderSnapshot],
  );

  useEffect(() => {
    const order = props.order;
    if (props.open && order) applyOrderSnapshot(order, false);
  }, [applyOrderSnapshot, props.open, props.order]);

  const currentOrderId = currentOrder?.id ?? null;
  const currentOrderCompleted = currentOrder ? paymentReachedBusiness(currentOrder) : false;
  const currentOrderFailed = currentOrder ? paymentReachedTerminalFailure(currentOrder) : false;
  useEffect(() => {
    if (!props.open || !currentOrderId || currentOrderCompleted || currentOrderFailed) {
      return;
    }
    const orderId = currentOrderId;
    let active = true;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const order = await api.orders.get(orderId);
        if (!active) return;
        completeIfReady(order);
      } catch {
        // 短暂断网不关闭支付窗口，用户可手动刷新。
      }
      const latest = latestOrder.current;
      const continuePolling = Boolean(
        latest &&
        latest.id === orderId &&
        !paymentReachedBusiness(latest) &&
        !paymentReachedTerminalFailure(latest),
      );
      if (active && continuePolling) {
        timer = window.setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [completeIfReady, currentOrderCompleted, currentOrderFailed, currentOrderId, props.open]);

  const handlePaymentResponse = async (response: PaymentResponse) => {
    completeIfReady(response.order);
    setAction(response.action);
    if (response.action.kind === "none") {
      completeIfReady(response.order);
      return;
    }
    if (response.action.kind === "wechat_oauth") {
      await platform.openExternal(response.action.authorizeUrl);
      return;
    }
    if (response.action.kind === "h5_redirect") {
      await platform.openExternal(response.action.h5Url);
      return;
    }
    if (response.action.kind === "jsapi") {
      await invokeWechatJsapi(response.action);
      await syncOrder();
    }
  };

  const pay = async (method: "balance" | "wechat") => {
    if (!currentOrder) return;
    setBusy(method);
    setError(null);
    try {
      const response = await api.orders.pay(
        currentOrder.id,
        method === "balance" ? { method } : { method, scene: preferredWechatScene() },
        paymentKey.current,
      );
      await handlePaymentResponse(response);
    } catch (cause) {
      setError(userErrorMessage(cause, "支付发起失败，请重试"));
    } finally {
      setBusy(null);
    }
  };

  const syncOrder = async () => {
    if (!currentOrder) return;
    setBusy("sync");
    setError(null);
    try {
      const order = await api.orders.sync(currentOrder.id, crypto.randomUUID());
      completeIfReady(order);
      if (!paymentReachedBusiness(order) && order.status === "pending_payment") {
        setError("暂未查询到支付结果，请稍后再试");
      }
    } catch (cause) {
      setError(userErrorMessage(cause, "支付状态查询失败，请重试"));
    } finally {
      setBusy(null);
    }
  };

  const closeOrder = async () => {
    if (!currentOrder || currentOrder.status !== "pending_payment") return;
    setBusy("close");
    setError(null);
    try {
      const closed = await api.orders.close(currentOrder.id, crypto.randomUUID());
      completeIfReady(closed);
      props.onOpenChange(false);
    } catch (cause) {
      setError(userErrorMessage(cause, "订单取消失败，请重试"));
    } finally {
      setBusy(null);
    }
  };

  const order =
    props.order && shouldApplyOrderSnapshot(currentOrder, props.order)
      ? props.order
      : (currentOrder ?? props.order);
  const rechargeCompleted = order?.type === "recharge" && paymentReachedBusiness(order);
  const renewalCompleted = order?.type === "machine_renewal" && paymentReachedBusiness(order);
  const renewalCompletedOrderId = renewalCompleted ? (order?.id ?? null) : null;
  const completionNoticeVisible = rechargeCompleted || renewalCompleted;
  useEffect(() => {
    if (!props.open || !renewalCompletedOrderId) return;
    const timer = window.setTimeout(
      () => callbacks.current.onOpenChange(false),
      RENEWAL_SUCCESS_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [props.open, renewalCompletedOrderId]);
  const balanceEnough =
    order !== null &&
    walletQuery.data !== undefined &&
    walletQuery.data.availableCents >= order.amountCents;
  const qrDataUrl =
    action?.kind === "native_qr" && qrImage?.codeUrl === action.codeUrl ? qrImage.dataUrl : null;
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && completionNoticeVisible) return;
        props.onOpenChange(open);
      }}
    >
      <DialogContent
        className="max-w-md border-zinc-800 bg-zinc-900 text-xs text-zinc-100"
        showCloseButton={!completionNoticeVisible}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">订单支付</DialogTitle>
          <DialogDescription className="text-xs text-zinc-400">
            {order ? `${order.description} · ${yuan(order.amountCents)}` : "正在准备订单…"}
          </DialogDescription>
        </DialogHeader>

        {order && paymentReachedBusiness(order) ? (
          <div className="flex items-center gap-3 rounded-[8px] border border-emerald-500/30 bg-emerald-500/10 p-3 text-emerald-400">
            <CheckCircle2 size={18} />
            <span>
              {order.type === "recharge"
                ? "充值成功，余额已到账"
                : order.type === "machine_renewal"
                  ? "续费成功"
                  : "支付完成，订单正在处理"}
            </span>
          </div>
        ) : order && paymentReachedTerminalFailure(order) ? (
          <div className="rounded-[8px] border px-3 py-3 cm-banner-danger">
            {order.status === "refunded"
              ? "订单处理失败，款项已经退回"
              : order.status === "closed"
                ? "订单已关闭，请重新创建订单"
                : "订单处理失败，请联系客服"}
          </div>
        ) : order?.status === "refund_pending" ? (
          <div className="rounded-[8px] border px-3 py-3 cm-banner-warning">
            支付已确认，但业务处理失败，系统正在自动退款
          </div>
        ) : order && ["paid", "fulfilling"].includes(order.status) ? (
          <div className="flex items-center gap-2 rounded-[8px] border border-emerald-500/30 bg-emerald-500/10 px-3 py-3 text-emerald-400">
            <LoaderCircle size={14} className="animate-spin" /> 支付成功，正在处理订单…
          </div>
        ) : action?.kind === "native_qr" ? (
          <div className="flex flex-col items-center gap-3 py-2">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="微信支付二维码"
                className="h-56 w-56 rounded-[8px] bg-white p-2"
              />
            ) : (
              <div className="flex h-56 w-56 items-center justify-center rounded-[8px] bg-white text-zinc-800">
                <LoaderCircle className="animate-spin" size={22} />
              </div>
            )}
            <span className="flex items-center gap-1.5 text-zinc-400">
              <QrCode size={13} /> 使用微信扫码完成支付
            </span>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {props.allowBalance && (
              <button
                type="button"
                className="cm-panel flex min-h-20 items-center gap-3 p-3 text-left transition-colors hover:bg-zinc-800"
                disabled={busy !== null || !order || walletQuery.isPending || !balanceEnough}
                onClick={() => void pay("balance")}
              >
                <WalletCards size={20} className="text-[var(--cm-accent)]" />
                <span>
                  <span className="block font-medium text-zinc-200">账户余额</span>
                  <span className="mt-1 block text-[11px] text-zinc-500">
                    可用 {walletQuery.data ? yuan(walletQuery.data.availableCents) : "—"}
                    {walletQuery.data && !balanceEnough ? " · 余额不足" : ""}
                  </span>
                </span>
              </button>
            )}
            <button
              type="button"
              className="cm-panel flex min-h-20 items-center gap-3 p-3 text-left transition-colors hover:bg-zinc-800"
              disabled={busy !== null || !order}
              onClick={() => void pay("wechat")}
            >
              <MessageCircle size={20} className="text-emerald-500" />
              <span>
                <span className="block font-medium text-zinc-200">微信支付</span>
                <span className="mt-1 block text-[11px] text-zinc-500">自动选择扫码或手机支付</span>
              </span>
            </button>
          </div>
        )}

        {busy && (
          <p className="flex items-center gap-2 text-zinc-500">
            <LoaderCircle size={12} className="animate-spin" /> 正在处理支付…
          </p>
        )}
        {props.allowBalance && walletQuery.isError && (
          <p className="text-zinc-500">余额暂时无法读取，仍可使用微信支付</p>
        )}
        {error && <p className="rounded-[8px] border px-3 py-2 cm-banner-danger">{error}</p>}

        {!completionNoticeVisible && (
          <DialogFooter className="border-zinc-800 bg-zinc-950/40">
            {order?.status === "pending_payment" && (
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void closeOrder()}
              >
                取消订单
              </Button>
            )}
            {order?.status === "pending_payment" && (
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void syncOrder()}
              >
                查询支付结果
              </Button>
            )}
            <Button size="xs" variant="outline" onClick={() => props.onOpenChange(false)}>
              稍后处理
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 订单或开关状态变化时重建会话，避免上一次二维码、错误和幂等键泄漏到下一次支付。 */
export function PaymentDialog(props: PaymentDialogProps) {
  return (
    <PaymentDialogSession
      key={`${props.open ? "open" : "closed"}:${props.order?.id ?? "empty"}`}
      {...props}
    />
  );
}
