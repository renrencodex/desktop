import { z } from "zod";

export const REFERRAL_DOMAIN_LABEL_MIN_LENGTH = 6;
export const REFERRAL_DOMAIN_LABEL_MAX_LENGTH = 32;

const REFERRAL_DOMAIN_LABEL_SHAPE_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const REFERRAL_DOMAIN_LABEL_LETTER_PATTERN = /[a-z]/;

export const REFERRAL_PAGE_THEME_IDS = [
  "classic",
  "mecha-green",
  "pixel-arcade",
  "anime-cel",
  "terminal-green",
  "sunrise-orange",
] as const;

export const referralPageThemeIdSchema = z.enum(REFERRAL_PAGE_THEME_IDS);
export type ReferralPageThemeId = z.infer<typeof referralPageThemeIdSchema>;
export const DEFAULT_REFERRAL_PAGE_THEME_ID: ReferralPageThemeId = "classic";

export function isReferralPageThemeId(value: unknown): value is ReferralPageThemeId {
  return referralPageThemeIdSchema.safeParse(value).success;
}

export const REFERRAL_PAGE_THEME_DEFINITIONS = [
  {
    id: "classic",
    name: "经典墨白",
    description: "克制留白，简洁高级",
    colorScheme: "light",
    previewColors: ["#faf9f6", "#171717", "#d8d4cc"],
  },
  {
    id: "mecha-green",
    name: "墨绿机甲",
    description: "装甲座舱，战术荧光",
    colorScheme: "dark",
    previewColors: ["#050b07", "#8eea54", "#173d27"],
  },
  {
    id: "pixel-arcade",
    name: "霓虹街机",
    description: "8-bit 街机，像素霓虹",
    colorScheme: "dark",
    previewColors: ["#07091d", "#35f2ff", "#ff3cab"],
  },
  {
    id: "anime-cel",
    name: "次元跃迁",
    description: "原创角色，赛璐璐光影",
    colorScheme: "light",
    previewColors: ["#fff8f3", "#5b5cff", "#ff6b91"],
  },
  {
    id: "terminal-green",
    name: "终端绿",
    description: "石墨终端，开发者气质",
    colorScheme: "dark",
    previewColors: ["#07110b", "#34d399", "#14532d"],
  },
  {
    id: "sunrise-orange",
    name: "暖阳橙",
    description: "橙金日轮，能量涌动",
    colorScheme: "light",
    previewColors: ["#fff7e8", "#ff6a00", "#ff365c"],
  },
] as const satisfies ReadonlyArray<{
  id: ReferralPageThemeId;
  name: string;
  description: string;
  colorScheme: "light" | "dark";
  previewColors: readonly [string, string, string];
}>;

/** 精确保留名；合法的 1–5 位名称和未包含英文字母的名称另由统一校验动态保留。 */
export const RESERVED_REFERRAL_DOMAIN_LABELS: ReadonlySet<string> = new Set([
  "account",
  "accounts",
  "admin",
  "admin1688",
  "agent",
  "agents",
  "ai",
  "api",
  "app",
  "artifacts",
  "assets",
  "auth",
  "billing",
  "business",
  "callback",
  "cdn",
  "checkout",
  "cloud",
  "code",
  "codex",
  "coding",
  "community",
  "computer",
  "computers",
  "console",
  "dashboard",
  "database",
  "desktop",
  "dev",
  "developer",
  "docs",
  "download",
  "downloads",
  "edge",
  "enterprise",
  "ftp",
  "gateway",
  "git",
  "health",
  "help",
  "identity",
  "images",
  "internal",
  "localhost",
  "login",
  "m",
  "machine",
  "machines",
  "mail",
  "marketplace",
  "metrics",
  "mobile",
  "monitor",
  "monitoring",
  "node",
  "ns1",
  "ns2",
  "oauth",
  "official",
  "origin",
  "packages",
  "partner",
  "partners",
  "payment",
  "payments",
  "platform",
  "preview",
  "pricing",
  "prod",
  "production",
  "referral",
  "referrals",
  "register",
  "registry",
  "release",
  "releases",
  "renren",
  "renrencodex",
  "root",
  "sandbox",
  "security",
  "service",
  "smtp",
  "staging",
  "static",
  "status",
  "storage",
  "studio",
  "support",
  "system",
  "telemetry",
  "terminal",
  "test",
  "uploads",
  "uptime",
  "vpn",
  "wallet",
  "web",
  "webhook",
  "webhooks",
  "websocket",
  "work",
  "workspace",
  "workspaces",
  "ws",
  "www",
]);

export type ReferralDomainLabelError = "invalid" | "reserved";

export function normalizeReferralDomainLabel(
  input: string,
): { label: string } | { error: ReferralDomainLabelError } {
  const label = input.trim().toLowerCase();
  if (
    label.length > REFERRAL_DOMAIN_LABEL_MAX_LENGTH ||
    !REFERRAL_DOMAIN_LABEL_SHAPE_PATTERN.test(label) ||
    label.startsWith("xn--")
  ) {
    return { error: "invalid" };
  }
  if (
    label.length < REFERRAL_DOMAIN_LABEL_MIN_LENGTH ||
    !REFERRAL_DOMAIN_LABEL_LETTER_PATTERN.test(label) ||
    RESERVED_REFERRAL_DOMAIN_LABELS.has(label)
  ) {
    return { error: "reserved" };
  }
  return { label };
}

export function referralDomainLabelFromHostname(hostname: string, suffix: string): string | null {
  const normalizedHost = hostname.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  const normalizedSuffix = suffix
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  const ending = `.${normalizedSuffix}`;
  if (!normalizedSuffix || !normalizedHost.endsWith(ending)) return null;
  const label = normalizedHost.slice(0, -ending.length);
  if (!label || label.includes(".")) return null;
  const normalized = normalizeReferralDomainLabel(label);
  return "label" in normalized ? normalized.label : null;
}
