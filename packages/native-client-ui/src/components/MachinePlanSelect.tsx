"use client";

import type { BillingPeriod, Plan } from "@cloud-machine/api-client";
import { Check } from "lucide-react";

import { planLabel } from "../lib/display-labels";

const ENTRY_PLAN_CODES = new Set(["Nano", "Dev Nano"]);

export function orderMachinePlans(
  plans: readonly Plan[],
  billingPeriod: BillingPeriod = "monthly",
): Plan[] {
  return [...plans].sort(
    (left, right) =>
      (billingPeriod === "annual" ? left.annualPriceCents : left.monthlyPriceCents) -
        (billingPeriod === "annual" ? right.annualPriceCents : right.monthlyPriceCents) ||
      left.cpu - right.cpu ||
      left.memoryMb - right.memoryMb ||
      left.diskGb - right.diskGb ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

export function preferredMachinePlanId(plans: readonly Plan[]): string {
  const orderedPlans = orderMachinePlans(plans);
  return (
    orderedPlans.find((plan) => ENTRY_PLAN_CODES.has(plan.code ?? plan.name))?.id ??
    orderedPlans[0]?.id ??
    ""
  );
}

export function reconcileMachinePlanId(plans: readonly Plan[], currentPlanId: string): string {
  return plans.some((plan) => plan.id === currentPlanId)
    ? currentPlanId
    : preferredMachinePlanId(plans);
}

export function MachinePlanSelect(props: {
  plans: Plan[];
  value: string;
  onValueChange: (value: string) => void;
  trialPlanIds?: readonly string[];
  trialDays?: number | null;
  billingPeriod?: BillingPeriod;
  peakBandwidthLabel?: string;
}) {
  const billingPeriod = props.billingPeriod ?? "monthly";
  const orderedPlans = orderMachinePlans(props.plans, billingPeriod);

  return (
    <div role="radiogroup" aria-labelledby="machine-plan-label" className="flex flex-col gap-2">
      {orderedPlans.map((plan) => {
        const selected = plan.id === props.value;
        return (
          <label
            key={plan.id}
            className={`group relative flex cursor-pointer items-center gap-3 rounded-[var(--cm-card-radius)] border p-2.5 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-[var(--cm-accent)] ${
              selected
                ? "border-[var(--cm-accent)] bg-[var(--cm-accent-muted)]"
                : "border-zinc-700 bg-zinc-950 hover:border-zinc-600 hover:bg-zinc-900"
            }`}
          >
            <input
              type="radio"
              name="planId"
              value={plan.id}
              checked={selected}
              required
              className="sr-only"
              onChange={() => props.onValueChange(plan.id)}
            />

            <span
              aria-hidden="true"
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors ${
                selected
                  ? "bg-[var(--cm-accent)] text-[var(--cm-accent-fg)]"
                  : "border border-zinc-700 text-transparent"
              }`}
            >
              <Check size={12} strokeWidth={2.5} />
            </span>

            <span className="shrink-0 text-xs font-medium text-zinc-200">
              {planLabel(plan.name, {
                code: plan.code,
                cpu: plan.cpu,
                memoryMb: plan.memoryMb,
                diskGb: plan.diskGb,
              })}
            </span>
            {props.trialPlanIds?.includes(plan.id) && (
              <span className="shrink-0 rounded border border-emerald-700/60 bg-emerald-950/50 px-1.5 py-0.5 text-[9px] font-medium text-emerald-300">
                免费试用{props.trialDays ?? 3}天
              </span>
            )}
            <span className="min-w-0 flex-1 text-[10px] leading-4 text-zinc-500">
              {`${plan.cpu} CPU · ${(plan.memoryMb / 1024).toFixed(0)} GB 内存 · ${plan.diskGb} GB 磁盘`}
              {props.peakBandwidthLabel && ` · ${props.peakBandwidthLabel}`}
              {plan.gpuCount > 0 && ` · ${plan.gpuCount}× ${plan.gpuType ?? "GPU"}`}
            </span>
            <span className="ml-auto shrink-0 text-[11px] font-medium text-[var(--cm-accent)]">
              ¥
              {(
                (billingPeriod === "annual" ? plan.annualPriceCents : plan.monthlyPriceCents) / 100
              ).toFixed(2)}
              /{billingPeriod === "annual" ? "365天" : "30天"}
            </span>
          </label>
        );
      })}
    </div>
  );
}
