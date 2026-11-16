import type { User } from "@cloud-machine/api-client";

export type SettingsSection =
  "account" | "wallet" | "orders" | "notifications" | "referrals" | "about";

export const SETTINGS_PATHS = {
  account: "/settings",
  wallet: "/settings/wallet",
  orders: "/settings/orders",
  notifications: "/settings/notifications",
  referrals: "/settings/referrals",
  about: "/settings/about",
} as const satisfies Record<SettingsSection, string>;

export const SETTINGS_RETURN_PARAM = "returnTo";
export const DEFAULT_SETTINGS_RETURN_PATH = "/machines";
export const REFERRAL_CENTER_TAB_PARAM = "referralTab";
export const REFERRAL_CENTER_TABS = ["overview", "domain", "records"] as const;
export type ReferralCenterTab = (typeof REFERRAL_CENTER_TABS)[number];

export function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_PATHS.account || pathname.startsWith(`${SETTINGS_PATHS.account}/`);
}

export function normalizeSettingsReturnPath(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const base = new URL("https://console.invalid");
    const destination = new URL(value, base);
    if (destination.origin !== base.origin) return null;
    if (
      destination.pathname !== DEFAULT_SETTINGS_RETURN_PATH &&
      !destination.pathname.startsWith(`${DEFAULT_SETTINGS_RETURN_PATH}/`)
    )
      return null;
    // session 只用于一次性新建终端，返回工作区时不能再次消费。
    destination.searchParams.delete("session");
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return null;
  }
}

export function settingsPathWithReturnTo(
  path: string,
  returnTo: string | null | undefined,
): string {
  const normalized = normalizeSettingsReturnPath(returnTo);
  if (!normalized) return path;
  const params = new URLSearchParams({ [SETTINGS_RETURN_PARAM]: normalized });
  return `${path}?${params.toString()}`;
}

export function normalizeReferralCenterTab(value: string | null | undefined): ReferralCenterTab {
  return REFERRAL_CENTER_TABS.includes(value as ReferralCenterTab)
    ? (value as ReferralCenterTab)
    : "overview";
}

export function referralSettingsPathWithTab(
  tab: ReferralCenterTab,
  currentSearch: string | null | undefined,
): string {
  const params = new URLSearchParams(currentSearch ?? "");
  params.set(REFERRAL_CENTER_TAB_PARAM, tab);
  return `${SETTINGS_PATHS.referrals}?${params.toString()}`;
}

export function accountInitial(user: Pick<User, "displayName" | "email"> | null): string {
  const source = user?.displayName.trim() || user?.email.trim() || "R";
  return [...source][0]?.toLocaleUpperCase() ?? "R";
}

export function accountStatusLabel(status: User["status"]): string {
  if (status === "active") return "正常";
  if (status === "suspended") return "已停用";
  return "已删除";
}
