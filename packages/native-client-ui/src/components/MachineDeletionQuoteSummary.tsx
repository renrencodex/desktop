"use client";

import type { MachineDeletionQuote } from "@cloud-machine/api-client";

function yuan(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

export function MachineDeletionQuoteSummary({
  quote,
  pending,
  error,
}: {
  quote: MachineDeletionQuote | null;
  pending: boolean;
  error: string | null;
}) {
  if (pending) return <span className="block py-2 text-zinc-400">正在计算退款金额…</span>;
  if (error) return <span className="block py-2 text-red-400">{error}</span>;
  if (!quote) return <span className="block py-2 text-zinc-500">等待退款报价…</span>;
  if (quote.totalRefundCents === 0) return null;

  const refundable = quote.items.filter((item) => item.refundCents > 0);
  return (
    <span className="mt-3 block rounded border border-zinc-800 bg-zinc-950/60 p-3">
      <span className="mb-2 block font-medium text-zinc-200">退款明细</span>
      {refundable.length === 0 ? (
        <span className="block text-zinc-500">当前没有可退余额。</span>
      ) : (
        refundable.map((item) => (
          <span key={item.orderId} className="flex justify-between gap-3 py-1 text-zinc-400">
            <span>
              <span className="block text-zinc-300">{item.description}</span>
              <span className="block text-[11px]">
                {item.usedDays === 0
                  ? `未开始周期（剩余 ${item.remainingDays} 天）`
                  : `当前周期（已用 ${item.usedDays} 天，剩余 ${item.remainingDays} 天）`}
              </span>
            </span>
            <span className="shrink-0 text-zinc-200">{yuan(item.refundCents)}</span>
          </span>
        ))
      )}
      <span className="mt-2 flex justify-between border-t border-zinc-800 pt-2 font-medium text-zinc-200">
        <span>退至账户余额</span>
        <span>{yuan(quote.totalRefundCents)}</span>
      </span>
      <span className="mt-2 block text-[11px] text-zinc-500">
        退款进入人人Codex账户余额，可用于后续消费，不退回原支付渠道且不可提现。
      </span>
    </span>
  );
}
