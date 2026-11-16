import type { BillingPeriod } from "./types";

export const MACHINE_PURCHASE_PATH = "/machines/new";

export interface MachinePurchaseSelection {
  planCode: string;
  billingPeriod: BillingPeriod;
}

function isSafePlanCode(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 80 &&
    value === value.trim() &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  );
}

export function parseMachinePurchaseSelection(
  search: string | URLSearchParams,
): MachinePurchaseSelection | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const planCode = params.get("planCode");
  const billingPeriod = params.get("billingPeriod");
  if (
    !planCode ||
    !isSafePlanCode(planCode) ||
    (billingPeriod !== "monthly" && billingPeriod !== "annual") ||
    params.getAll("planCode").length !== 1 ||
    params.getAll("billingPeriod").length !== 1 ||
    [...params.keys()].some((key) => key !== "planCode" && key !== "billingPeriod")
  ) {
    return null;
  }
  return { planCode, billingPeriod };
}

export function machinePurchasePath(planCode: string, billingPeriod: BillingPeriod): string {
  const selection = parseMachinePurchaseSelection(new URLSearchParams({ planCode, billingPeriod }));
  if (!selection) throw new RangeError("invalid machine purchase selection");
  return `${MACHINE_PURCHASE_PATH}?${new URLSearchParams({
    planCode: selection.planCode,
    billingPeriod: selection.billingPeriod,
  }).toString()}`;
}

/** 登录和注册只接受这一种受信任的购机回跳地址，拒绝开放重定向。 */
export function machinePurchaseReturnPath(candidate: string | null): string | null {
  if (!candidate) return null;
  const base = new URL("https://web.invalid");
  try {
    const parsed = new URL(candidate, base);
    if (parsed.origin !== base.origin || parsed.pathname !== MACHINE_PURCHASE_PATH || parsed.hash) {
      return null;
    }
    const selection = parseMachinePurchaseSelection(parsed.searchParams);
    return selection ? machinePurchasePath(selection.planCode, selection.billingPeriod) : null;
  } catch {
    return null;
  }
}
