"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Eye, Globe2, Palette, RotateCcw, X } from "lucide-react";
import { ReferralBankAccount } from "@cloud-machine/workspace-ui/referral-bank-account";
import {
  DEFAULT_REFERRAL_PAGE_THEME_ID,
  REFERRAL_DOMAIN_LABEL_MAX_LENGTH,
  REFERRAL_DOMAIN_LABEL_MIN_LENGTH,
  REFERRAL_PAGE_THEME_DEFINITIONS,
  normalizeReferralDomainLabel,
  type ReferralPageThemeId,
} from "@cloud-machine/client-contracts";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import type {
  BillingPeriod,
  ReferralOverview,
  ReferralPage,
  ReferralPagination,
  ReferralRate,
} from "@cloud-machine/api-client";

import { api } from "../lib/api";
import { planLabel } from "../lib/display-labels";
import { LANDING_HERO_COPY, PUBLIC_PRODUCT_CATEGORY } from "../lib/landing-hero-copy";
import type { ReferralCenterTab } from "../lib/settings";
import { userErrorMessage } from "../lib/user-error";
import { toastError, toastSuccess } from "../stores/toast";

const money = (cents: number) => `¥${(cents / 100).toFixed(2)}`;
const time = (value: string) => new Date(value).toLocaleString("zh-CN");
const orderStatus = (status: string, refundedCents: number) => {
  if (status === "refund_pending") return "退款处理中";
  if (status === "refunded") return "已退款";
  if (status === "partially_refunded" || refundedCents > 0) return "部分退款";
  if (status === "fulfilled") return "已完成";
  if (status === "failed") return "处理失败";
  return "履约中";
};
const commissionStatus = (status: string) => {
  if (status === "pending") return "待结算";
  if (status === "settled") return "已结算";
  if (status === "adjusting") return "退款调整待结算";
  if (status === "adjusted") return "部分退款已调整";
  return "已退款冲销";
};
const payoutStatus = (status: string) => {
  if (status === "queued") return "等待打款";
  if (status === "submitting" || status === "reconciling") return "处理中";
  if (status === "waiting_funds") return "等待商户入金";
  if (status === "succeeded") return "已打款";
  if (status === "processing") return "处理中";
  if (status === "cancelled") return "已取消";
  if (status === "returned") return "款项已退回";
  if (status === "manual_review") return "待核实";
  if (status === "skipped") return "本期跳过";
  return "打款失败";
};

const REFERRAL_CENTER_NAV_ITEMS = [
  { id: "overview", label: "经营概览" },
  { id: "domain", label: "专属域名" },
  { id: "records", label: "推广记录" },
] as const satisfies ReadonlyArray<{ id: ReferralCenterTab; label: string }>;

const REFERRAL_RECORD_TABS = [
  { id: "users", label: "推荐用户" },
  { id: "orders", label: "购买记录" },
  { id: "commissions", label: "佣金记录" },
  { id: "settlements", label: "月结记录" },
  { id: "payouts", label: "打款记录" },
] as const;

type ReferralRecordTab = (typeof REFERRAL_RECORD_TABS)[number]["id"];
type ReferralPageState = Record<ReferralRecordTab, { page: number; pageSize: number }>;

const initialPageState = (): ReferralPageState => ({
  users: { page: 1, pageSize: 20 },
  orders: { page: 1, pageSize: 20 },
  commissions: { page: 1, pageSize: 20 },
  settlements: { page: 1, pageSize: 20 },
  payouts: { page: 1, pageSize: 20 },
});

interface TableRow {
  id: string;
  cells: string[];
}

interface TableModel {
  empty: string;
  headers: string[];
  rows: TableRow[];
  loading: boolean;
  fetching: boolean;
  error: unknown;
  pagination: ReferralPagination | null;
  retry: () => void;
}

function ReferralThemeArtwork({
  themeId,
  colors,
  colorScheme,
  compact = false,
}: {
  themeId: ReferralPageThemeId;
  colors: readonly [string, string, string];
  colorScheme: "light" | "dark";
  compact?: boolean;
}) {
  const foreground = colorScheme === "dark" ? "#f4f4f5" : "#18181b";
  const muted = colorScheme === "dark" ? "#a1a1aa" : "#52525b";
  const kicker =
    themeId === "mecha-green"
      ? "TACTICAL AGENT SYSTEM"
      : themeId === "pixel-arcade"
        ? "WORKSPACE QUEST"
        : themeId === "anime-cel"
          ? "AGENT STORY / EP.01"
          : themeId === "terminal-green"
            ? "agent_machine.init"
            : themeId === "sunrise-orange"
              ? "DAYBREAK WORKFLOW"
              : PUBLIC_PRODUCT_CATEGORY;

  return (
    <div
      className={`relative overflow-hidden ${compact ? "h-24 rounded-lg p-3" : "min-h-[24rem] p-6 sm:p-10"}`}
      style={{
        background: `linear-gradient(${colorScheme === "dark" ? "rgb(255 255 255 / 3%)" : "rgb(255 255 255 / 28%)"} 1px, transparent 1px), linear-gradient(90deg, ${colorScheme === "dark" ? "rgb(255 255 255 / 3%)" : "rgb(255 255 255 / 28%)"} 1px, transparent 1px), radial-gradient(circle at 78% 20%, ${colors[2]}, transparent 42%), ${colors[0]}`,
        backgroundSize: compact
          ? "12px 12px, 12px 12px, auto, auto"
          : "28px 28px, 28px 28px, auto, auto",
        color: foreground,
      }}
      data-referral-theme-artwork={themeId}
    >
      <div
        className={`relative z-10 flex items-center justify-between ${compact ? "text-[5px]" : "text-sm"}`}
      >
        <strong>人人Codex</strong>
        <span
          className={compact ? "h-4 w-9" : "rounded-lg px-3 py-2 text-xs font-semibold"}
          style={{ background: colors[1], color: colorScheme === "dark" ? colors[0] : "#fff" }}
        >
          {!compact && "立即注册"}
        </span>
      </div>

      <div className={`relative z-10 ${compact ? "mt-4 w-3/5" : "mt-14 max-w-[62%]"}`}>
        <p
          className={`${compact ? "text-[4px]" : "text-xs"} font-semibold tracking-[0.18em] opacity-75`}
        >
          {kicker}
        </p>
        {compact ? (
          <>
            <span className="mt-2 block h-2 w-full bg-current opacity-90" />
            <span className="mt-1.5 block h-1.5 w-4/5 bg-current opacity-35" />
            <span className="mt-3 block h-4 w-12" style={{ background: colors[1] }} />
          </>
        ) : (
          <>
            <h4 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
              {LANDING_HERO_COPY.title}
            </h4>
            <p className="mt-4 text-base font-semibold" style={{ color: colors[1] }}>
              {LANDING_HERO_COPY.benefitLine}
            </p>
            <p className="mt-3 max-w-lg text-sm leading-7" style={{ color: muted }}>
              {LANDING_HERO_COPY.description}
            </p>
            <span
              className="mt-7 inline-flex rounded-lg px-4 py-2.5 text-xs font-semibold"
              style={{ background: colors[1], color: colorScheme === "dark" ? colors[0] : "#fff" }}
            >
              立即开始
            </span>
          </>
        )}
      </div>

      <div
        className={`absolute ${compact ? "bottom-3 right-3 h-10 w-16" : "bottom-8 right-8 h-40 w-52"}`}
        aria-hidden="true"
      >
        {themeId === "mecha-green" ? (
          <div
            className="absolute inset-0 rounded-full border-2"
            style={{ borderColor: colors[1], boxShadow: `inset 0 0 0 8px ${colors[2]}` }}
          >
            <i className="absolute left-1/2 top-0 h-full w-px bg-current opacity-40" />
            <i className="absolute left-0 top-1/2 h-px w-full bg-current opacity-40" />
          </div>
        ) : themeId === "pixel-arcade" ? (
          <div
            className="grid h-full grid-cols-4 gap-1 border-2 p-2"
            style={{ borderColor: colors[1], boxShadow: `4px 4px 0 ${colors[2]}` }}
          >
            {[0, 1, 2, 3, 4, 5, 6, 7].map((cell) => (
              <i
                key={cell}
                style={{ background: cell === 2 || cell === 5 ? colors[1] : colors[2] }}
              />
            ))}
          </div>
        ) : themeId === "anime-cel" ? (
          <div
            className="absolute inset-0 rotate-3 rounded-[45%_55%_46%_54%] border-2 bg-white/60"
            style={{ borderColor: foreground, boxShadow: `5px 5px 0 ${colors[2]}` }}
          >
            <i
              className="absolute left-1/2 top-[14%] h-[38%] w-[35%] -translate-x-1/2 rounded-full"
              style={{ background: colors[1] }}
            />
            <i
              className="absolute bottom-[8%] left-[18%] right-[18%] h-[42%] rounded-t-full"
              style={{ background: colors[2] }}
            />
          </div>
        ) : themeId === "terminal-green" ? (
          <div
            className="h-full border p-2 font-mono text-[5px] sm:text-[9px]"
            style={{ borderColor: colors[1], color: colors[1] }}
          >
            <p>$ workspace boot</p>
            <p className="mt-2 opacity-65">[ OK ] environment</p>
            <p className="opacity-65">[ OK ] tasks 24/7</p>
            <p className="mt-2">$_</p>
          </div>
        ) : themeId === "sunrise-orange" ? (
          <div className="absolute inset-0 grid place-items-center rounded-full">
            <i
              className="absolute inset-0 rounded-full"
              style={{
                background: `repeating-conic-gradient(transparent 0deg 12deg, ${colors[1]}33 12deg 16deg)`,
              }}
            />
            <i
              className="absolute inset-[18%] rounded-full border"
              style={{ borderColor: `${colors[1]}88` }}
            />
            <i
              className="absolute inset-[29%] rounded-full"
              style={{
                background: `radial-gradient(circle at 32% 28%, white, ${colors[2]} 34%, ${colors[1]} 75%)`,
                boxShadow: `0 0 ${compact ? "12px" : "32px"} ${colors[1]}66`,
              }}
            />
          </div>
        ) : (
          <div
            className="h-full w-full rounded-full opacity-70"
            style={{
              background: `radial-gradient(circle at 35% 30%, white, ${colors[1]} 55%, ${colors[2]})`,
            }}
          />
        )}
      </div>
    </div>
  );
}

function ReferralThemeSelector({
  currentThemeId,
  selectedThemeId,
  domainUrl,
  enabled,
  pending,
  error,
  onChange,
  onRestore,
  onSave,
}: {
  currentThemeId: ReferralPageThemeId;
  selectedThemeId: ReferralPageThemeId;
  domainUrl: string;
  enabled: boolean;
  pending: boolean;
  error: unknown;
  onChange: (themeId: ReferralPageThemeId) => void;
  onRestore: () => void;
  onSave: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewCloseButtonRef = useRef<HTMLButtonElement>(null);
  const selectedTheme =
    REFERRAL_PAGE_THEME_DEFINITIONS.find((theme) => theme.id === selectedThemeId) ??
    REFERRAL_PAGE_THEME_DEFINITIONS[0];
  const dirty = selectedThemeId !== currentThemeId;

  useEffect(() => {
    if (!previewOpen) return;
    previewCloseButtonRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setPreviewOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewOpen]);

  return (
    <div className="mt-6 border-t border-zinc-800 pt-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
            <Palette size={14} /> 专属页面主题
          </div>
          <p className="mt-1.5 text-[11px] leading-5 text-zinc-500">
            主题会统一应用于专属首页、价格页和注册页，由你为访客保持一致的页面风格。
          </p>
        </div>
        <button
          type="button"
          className="cm-button h-8 shrink-0 gap-1.5 px-3 text-xs"
          onClick={() => setPreviewOpen(true)}
        >
          <Eye size={13} /> 放大预览
        </button>
      </div>

      <fieldset className="mt-4" disabled={!enabled || pending}>
        <legend className="sr-only">选择专属页面主题</legend>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {REFERRAL_PAGE_THEME_DEFINITIONS.map((theme) => {
            const selected = selectedThemeId === theme.id;
            const current = currentThemeId === theme.id;
            return (
              <label
                key={theme.id}
                data-referral-theme-option={theme.id}
                className={`relative cursor-pointer overflow-hidden rounded-xl border p-2 transition-[border-color,box-shadow,transform] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--cm-accent)] ${
                  selected
                    ? "border-[var(--cm-accent)] shadow-[0_0_0_1px_var(--cm-accent)]"
                    : "border-zinc-800 hover:-translate-y-0.5 hover:border-zinc-600"
                } ${!enabled ? "cursor-not-allowed opacity-65" : ""}`}
              >
                <input
                  type="radio"
                  name="referral-page-theme"
                  value={theme.id}
                  checked={selected}
                  className="sr-only"
                  onChange={() => onChange(theme.id)}
                />
                <ReferralThemeArtwork
                  themeId={theme.id}
                  colors={theme.previewColors}
                  colorScheme={theme.colorScheme}
                  compact
                />
                <div className="flex items-start justify-between gap-2 px-1 pb-1 pt-2.5">
                  <div>
                    <p className="text-xs font-medium text-zinc-200">{theme.name}</p>
                    <p className="mt-0.5 text-[10px] text-zinc-500">{theme.description}</p>
                  </div>
                  {current && (
                    <span className="shrink-0 rounded-full bg-zinc-800 px-2 py-0.5 text-[9px] text-zinc-400">
                      当前
                    </span>
                  )}
                </div>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <button
          type="button"
          className="cm-button-primary h-8 px-3 text-xs"
          disabled={!enabled || pending || !dirty}
          onClick={onSave}
        >
          {pending ? "保存中…" : "保存主题"}
        </button>
        <button
          type="button"
          className="cm-button h-8 gap-1.5 px-3 text-xs"
          disabled={pending || !dirty}
          onClick={onRestore}
        >
          <RotateCcw size={12} /> 恢复当前主题
        </button>
        <a
          href={domainUrl}
          target="_blank"
          rel="noreferrer"
          className="cm-button h-8 gap-1.5 px-3 text-xs sm:ml-auto"
        >
          查看专属页面 <ExternalLink size={12} />
        </a>
      </div>
      {error !== null && error !== undefined && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {userErrorMessage(error, "主题保存失败")}
        </p>
      )}

      {previewOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="referral-theme-preview-title"
          className="fixed inset-0 z-80 flex items-center justify-center bg-black/70 p-4"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setPreviewOpen(false);
          }}
        >
          <section className="w-full max-w-3xl overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl">
            <header className="flex h-12 items-center justify-between border-b border-zinc-800 px-4">
              <div>
                <h3 id="referral-theme-preview-title" className="text-xs font-medium text-zinc-200">
                  {selectedTheme.name}预览
                </h3>
                <p className="text-[10px] text-zinc-600">保存后将应用于全部专属页面</p>
              </div>
              <button
                ref={previewCloseButtonRef}
                type="button"
                aria-label="关闭主题预览"
                className="cm-icon-button h-7 w-7"
                onClick={() => setPreviewOpen(false)}
              >
                <X size={14} />
              </button>
            </header>
            <ReferralThemeArtwork
              themeId={selectedTheme.id}
              colors={selectedTheme.previewColors}
              colorScheme={selectedTheme.colorScheme}
            />
          </section>
        </div>
      )}
    </div>
  );
}

function latestReferralPage<T>(
  queryClient: QueryClient,
  resource: ReferralRecordTab,
  current: ReferralPage<T> | undefined,
): ReferralPage<T> | undefined {
  if (current) return current;
  let latest: { data: ReferralPage<T>; updatedAt: number } | undefined;
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ["referrals", resource] })) {
    if (query.state.data === undefined || query.state.dataUpdatedAt < (latest?.updatedAt ?? -1)) {
      continue;
    }
    latest = {
      data: query.state.data as ReferralPage<T>,
      updatedAt: query.state.dataUpdatedAt,
    };
  }
  return latest?.data;
}

const referralPeriodRate = (rate: ReferralRate, billingPeriod: BillingPeriod) =>
  billingPeriod === "annual"
    ? {
        platformPriceCents: rate.annualPlatformPriceCents,
        costPriceCents: rate.annualCostPriceCents,
        salePriceCents: rate.annualSalePriceCents,
        commissionCents: rate.annualCommissionCents,
        saleInherited: rate.annualSaleInherited,
      }
    : {
        platformPriceCents: rate.platformPriceCents,
        costPriceCents: rate.costPriceCents,
        salePriceCents: rate.salePriceCents,
        commissionCents: rate.commissionCents,
        saleInherited: rate.saleInherited,
      };

const REFERRAL_BILLING_PERIODS = ["monthly", "annual"] as const;

const referralBillingPeriodLabel = (billingPeriod: BillingPeriod) =>
  billingPeriod === "annual" ? "按年付费(365天)" : "按月付费(30天)";

const referralPriceDraftKey = (planId: string, billingPeriod: BillingPeriod) =>
  `${planId}:${billingPeriod}`;

const parseSalePriceCents = (value: string): number | null => {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
};

const salePriceValidationError = (
  value: string,
  costPriceCents: number,
  platformPriceCents: number,
): string | null => {
  const cents = parseSalePriceCents(value);
  if (cents === null) return "请输入金额，最多保留两位小数";
  if (cents < costPriceCents) return `销售价不能低于成本价 ${money(costPriceCents)}`;
  if (cents > platformPriceCents) return `销售价不能高于平台价 ${money(platformPriceCents)}`;
  return null;
};

function ReferralPricePeriod({
  rate,
  billingPeriod,
  saleValue,
  enabled,
  pending,
  requestError,
  onDraftChange,
  onUndo,
  onSave,
}: {
  rate: ReferralRate;
  billingPeriod: BillingPeriod;
  saleValue: string;
  enabled: boolean;
  pending: boolean;
  requestError: string | undefined;
  onDraftChange: (rate: ReferralRate, billingPeriod: BillingPeriod, value: string) => void;
  onUndo: (planId: string, billingPeriod: BillingPeriod) => void;
  onSave: (planId: string, billingPeriod: BillingPeriod, inherited: boolean) => void;
}) {
  const values = referralPeriodRate(rate, billingPeriod);
  const inputId = `sale-${rate.planId}-${billingPeriod}`;
  const parsedSalePriceCents = parseSalePriceCents(saleValue);
  const validationError = salePriceValidationError(
    saleValue,
    values.costPriceCents,
    values.platformPriceCents,
  );
  const dirty = parsedSalePriceCents !== values.salePriceCents;
  const previewCommissionCents =
    validationError === null && parsedSalePriceCents !== null
      ? parsedSalePriceCents - values.costPriceCents
      : null;
  const status = dirty ? "待保存" : values.saleInherited ? "跟随平台价" : "自定义售价";
  const statusClass = dirty
    ? "border-amber-900/70 bg-amber-950/30 text-amber-300"
    : values.saleInherited
      ? "border-zinc-700 bg-zinc-900 text-zinc-400"
      : "border-sky-500/60 bg-sky-500/10 text-sky-400";
  return (
    <form
      className="rounded-lg border border-zinc-800 bg-zinc-950/25 p-3.5"
      data-referral-price-period={billingPeriod}
      aria-label={`${planLabel(rate.planName)}${referralBillingPeriodLabel(billingPeriod)}定价`}
      aria-busy={pending}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSave(rate.planId, billingPeriod, false);
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-xs font-medium text-zinc-200">
          {referralBillingPeriodLabel(billingPeriod)}
        </h4>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] leading-4 ${statusClass}`}
        >
          {status}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-zinc-500">平台价</dt>
          <dd className="mt-1 font-medium text-zinc-300">{money(values.platformPriceCents)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">成本价</dt>
          <dd className="mt-1 font-medium text-zinc-300">{money(values.costPriceCents)}</dd>
        </div>
      </dl>
      <label className="mt-3.5 block text-[11px] font-medium text-zinc-400" htmlFor={inputId}>
        销售价（元）
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id={inputId}
          className="cm-input min-w-0 flex-1 text-xs"
          type="number"
          inputMode="decimal"
          min={(values.costPriceCents / 100).toFixed(2)}
          max={(values.platformPriceCents / 100).toFixed(2)}
          step="0.01"
          value={saleValue}
          disabled={!enabled || pending}
          aria-invalid={validationError !== null}
          aria-describedby={`${inputId}-hint${requestError ? ` ${inputId}-error` : ""}`}
          onChange={(event) => onDraftChange(rate, billingPeriod, event.target.value)}
        />
        <button
          type="submit"
          className="cm-button-primary h-8 shrink-0 px-2.5 text-xs"
          disabled={!enabled || pending || !dirty || validationError !== null}
        >
          {pending ? "保存中…" : "保存"}
        </button>
      </div>
      <p
        id={`${inputId}-hint`}
        className={`mt-1.5 min-h-4 text-[10px] leading-4 ${validationError ? "text-red-400" : "text-zinc-600"}`}
      >
        {validationError ??
          `可设置范围 ${money(values.costPriceCents)}–${money(values.platformPriceCents)}`}
      </p>
      <div className="mt-3 flex items-center justify-between rounded-md border border-emerald-950/80 bg-emerald-950/20 px-3 py-2">
        <span className="text-[11px] text-zinc-500">佣金</span>
        <strong className="text-sm font-semibold text-emerald-400">
          {previewCommissionCents === null ? "—" : money(previewCommissionCents)}
        </strong>
      </div>
      <div className="mt-2.5 min-h-4 text-[11px]">
        {dirty ? (
          <button
            type="button"
            className="text-zinc-400 hover:text-zinc-200 disabled:text-zinc-600"
            disabled={!enabled || pending}
            data-referral-price-action="undo"
            onClick={() => onUndo(rate.planId, billingPeriod)}
          >
            撤销修改
          </button>
        ) : values.saleInherited ? (
          <span className="text-zinc-600">当前销售价跟随平台价</span>
        ) : (
          <button
            type="button"
            className="text-sky-400 hover:text-sky-500 disabled:text-zinc-600"
            disabled={!enabled || pending}
            data-referral-price-action="restore"
            onClick={() => onSave(rate.planId, billingPeriod, true)}
          >
            恢复平台价
          </button>
        )}
      </div>
      {requestError && (
        <p id={`${inputId}-error`} role="alert" className="mt-2 text-[11px] text-red-400">
          {requestError}
        </p>
      )}
    </form>
  );
}

function ReferralPriceGroup({
  rate,
  enabled,
  saleValue,
  pending,
  requestError,
  onDraftChange,
  onUndo,
  onSave,
}: {
  rate: ReferralRate;
  enabled: boolean;
  saleValue: (billingPeriod: BillingPeriod) => string;
  pending: (billingPeriod: BillingPeriod) => boolean;
  requestError: (billingPeriod: BillingPeriod) => string | undefined;
  onDraftChange: (rate: ReferralRate, billingPeriod: BillingPeriod, value: string) => void;
  onUndo: (planId: string, billingPeriod: BillingPeriod) => void;
  onSave: (planId: string, billingPeriod: BillingPeriod, inherited: boolean) => void;
}) {
  const customizedPeriods = Number(!rate.saleInherited) + Number(!rate.annualSaleInherited);
  return (
    <article
      className="overflow-hidden rounded-xl border border-zinc-800 bg-[var(--cm-surface-panel)]"
      data-referral-price-group={rate.planId}
    >
      <header className="flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/20 px-4 py-3">
        <h3 className="text-sm font-semibold text-zinc-100">{planLabel(rate.planName)}</h3>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${
            customizedPeriods === 0
              ? "border-zinc-700 text-zinc-500"
              : "border-sky-500/60 bg-sky-500/10 text-sky-400"
          }`}
        >
          {customizedPeriods === 0 ? "全部跟随平台价" : `已自定义 ${customizedPeriods}/2 项`}
        </span>
      </header>
      <div className="grid gap-3 p-3 md:grid-cols-2">
        {REFERRAL_BILLING_PERIODS.map((billingPeriod) => (
          <ReferralPricePeriod
            key={billingPeriod}
            rate={rate}
            billingPeriod={billingPeriod}
            saleValue={saleValue(billingPeriod)}
            enabled={enabled}
            pending={pending(billingPeriod)}
            requestError={requestError(billingPeriod)}
            onDraftChange={onDraftChange}
            onUndo={onUndo}
            onSave={onSave}
          />
        ))}
      </div>
    </article>
  );
}

export function ReferralSettings({
  activeTab,
  onTabChange,
}: {
  activeTab: ReferralCenterTab;
  onTabChange: (tab: ReferralCenterTab) => void;
}) {
  const [activeRecordTab, setActiveRecordTab] = useState<ReferralRecordTab>("users");
  const [pageState, setPageState] = useState<ReferralPageState>(initialPageState);
  const queryClient = useQueryClient();
  const overview = useQuery({
    queryKey: ["referrals", "overview"],
    queryFn: () => api.account.referrals.overview(),
  });
  const referredUsers = useQuery({
    queryKey: ["referrals", "users", pageState.users.page, pageState.users.pageSize],
    queryFn: () => api.account.referrals.users(pageState.users),
    enabled: activeTab === "records" && activeRecordTab === "users",
    placeholderData: (previous) => previous,
  });
  const commissions = useQuery({
    queryKey: [
      "referrals",
      "commissions",
      pageState.commissions.page,
      pageState.commissions.pageSize,
    ],
    queryFn: () => api.account.referrals.commissions(pageState.commissions),
    enabled: activeTab === "records" && activeRecordTab === "commissions",
    placeholderData: (previous) => previous,
  });
  const orders = useQuery({
    queryKey: ["referrals", "orders", pageState.orders.page, pageState.orders.pageSize],
    queryFn: () => api.account.referrals.orders(pageState.orders),
    enabled: activeTab === "records" && activeRecordTab === "orders",
    placeholderData: (previous) => previous,
  });
  const settlements = useQuery({
    queryKey: [
      "referrals",
      "settlements",
      pageState.settlements.page,
      pageState.settlements.pageSize,
    ],
    queryFn: () => api.account.referrals.settlements(pageState.settlements),
    enabled: activeTab === "records" && activeRecordTab === "settlements",
    placeholderData: (previous) => previous,
  });
  const payouts = useQuery({
    queryKey: ["referrals", "payouts", pageState.payouts.page, pageState.payouts.pageSize],
    queryFn: () => api.account.referrals.payouts(pageState.payouts),
    enabled: activeTab === "records" && activeRecordTab === "payouts",
    placeholderData: (previous) => previous,
  });
  const referredUsersPage = latestReferralPage(queryClient, "users", referredUsers.data);
  const ordersPage = latestReferralPage(queryClient, "orders", orders.data);
  const commissionsPage = latestReferralPage(queryClient, "commissions", commissions.data);
  const settlementsPage = latestReferralPage(queryClient, "settlements", settlements.data);
  const payoutsPage = latestReferralPage(queryClient, "payouts", payouts.data);
  const domainSourceLabel = overview.data?.domain?.label ?? "";
  const [domainDraft, setDomainDraft] = useState<{ source: string; value: string } | null>(null);
  const domainLabel =
    domainDraft?.source === domainSourceLabel ? domainDraft.value : domainSourceLabel;
  const currentThemeId = overview.data?.pageThemeId ?? DEFAULT_REFERRAL_PAGE_THEME_ID;
  const [themeDraft, setThemeDraft] = useState<{
    source: ReferralPageThemeId;
    value: ReferralPageThemeId;
  } | null>(null);
  const selectedThemeId = themeDraft?.source === currentThemeId ? themeDraft.value : currentThemeId;
  const [saleDrafts, setSaleDrafts] = useState<Record<string, { source: string; value: string }>>(
    {},
  );
  const [salePriceErrors, setSalePriceErrors] = useState<Record<string, string>>({});
  const pendingSalePriceKeys = useRef(new Set<string>());
  const [pendingSalePrices, setPendingSalePrices] = useState<ReadonlySet<string>>(new Set());
  const domainUpdateKey = useRef(crypto.randomUUID());
  const themeUpdateKey = useRef(crypto.randomUUID());
  const priceUpdateKeys = useRef(new Map<string, string>());
  const saleDraftValue = (rate: ReferralRate, billingPeriod: BillingPeriod) => {
    const values = referralPeriodRate(rate, billingPeriod);
    const source = `${values.salePriceCents}:${values.saleInherited ? "inherited" : "custom"}`;
    const draft = saleDrafts[referralPriceDraftKey(rate.planId, billingPeriod)];
    return draft?.source === source ? draft.value : (values.salePriceCents / 100).toFixed(2);
  };
  const changeSaleDraft = (rate: ReferralRate, billingPeriod: BillingPeriod, value: string) => {
    const values = referralPeriodRate(rate, billingPeriod);
    const draftKey = referralPriceDraftKey(rate.planId, billingPeriod);
    setSaleDrafts((current) => ({
      ...current,
      [draftKey]: {
        source: `${values.salePriceCents}:${values.saleInherited ? "inherited" : "custom"}`,
        value,
      },
    }));
    setSalePriceErrors((current) => {
      if (!(draftKey in current)) return current;
      const next = { ...current };
      delete next[draftKey];
      return next;
    });
    priceUpdateKeys.current.delete(draftKey);
  };
  const clearSaleDraft = (planId: string, billingPeriod: BillingPeriod) => {
    const draftKey = referralPriceDraftKey(planId, billingPeriod);
    setSaleDrafts((current) => {
      if (!(draftKey in current)) return current;
      const next = { ...current };
      delete next[draftKey];
      return next;
    });
    setSalePriceErrors((current) => {
      if (!(draftKey in current)) return current;
      const next = { ...current };
      delete next[draftKey];
      return next;
    });
    priceUpdateKeys.current.delete(draftKey);
  };
  const updateDomain = useMutation({
    mutationFn: (input: { label: string; idempotencyKey: string }) =>
      api.account.referrals.updateDomain(input.label, input.idempotencyKey),
    onSuccess: async () => {
      domainUpdateKey.current = crypto.randomUUID();
      await queryClient.invalidateQueries({ queryKey: ["referrals", "overview"] });
      toastSuccess("专属域名已更新");
    },
  });
  const updatePageTheme = useMutation({
    mutationFn: (input: { themeId: ReferralPageThemeId; idempotencyKey: string }) =>
      api.account.referrals.updatePageTheme(input.themeId, input.idempotencyKey),
    onSuccess: async (result) => {
      setThemeDraft(null);
      themeUpdateKey.current = crypto.randomUUID();
      queryClient.setQueryData<ReferralOverview>(["referrals", "overview"], (current) =>
        current ? { ...current, pageThemeId: result.themeId } : current,
      );
      await queryClient.invalidateQueries({ queryKey: ["referrals", "overview"] });
      toastSuccess("专属页面主题已更新");
    },
  });
  const updateSalePrice = useMutation({
    mutationFn: (input: {
      planId: string;
      billingPeriod: BillingPeriod;
      salePriceCents: number | null;
      idempotencyKey: string;
    }) =>
      api.account.referrals.updateSalePrice(
        input.planId,
        input.salePriceCents,
        input.idempotencyKey,
        input.billingPeriod,
      ),
    onMutate: (input) => {
      const draftKey = referralPriceDraftKey(input.planId, input.billingPeriod);
      pendingSalePriceKeys.current.add(draftKey);
      setPendingSalePrices(new Set(pendingSalePriceKeys.current));
      setSalePriceErrors((current) => {
        if (!(draftKey in current)) return current;
        const next = { ...current };
        delete next[draftKey];
        return next;
      });
    },
    onSuccess: async (result, input) => {
      clearSaleDraft(input.planId, input.billingPeriod);
      queryClient.setQueryData<ReferralOverview>(["referrals", "overview"], (current) =>
        current
          ? {
              ...current,
              rates: current.rates.map((rate) => (rate.planId === result.planId ? result : rate)),
            }
          : current,
      );
      await queryClient.invalidateQueries({ queryKey: ["referrals", "overview"] });
      toastSuccess(`${referralBillingPeriodLabel(input.billingPeriod)}销售价已更新`);
    },
    onError: (error, input) => {
      const draftKey = referralPriceDraftKey(input.planId, input.billingPeriod);
      setSalePriceErrors((current) => ({
        ...current,
        [draftKey]: userErrorMessage(error, "销售价更新失败"),
      }));
    },
    onSettled: (_result, _error, input) => {
      const draftKey = referralPriceDraftKey(input.planId, input.billingPeriod);
      pendingSalePriceKeys.current.delete(draftKey);
      setPendingSalePrices(new Set(pendingSalePriceKeys.current));
    },
  });

  const submitDomain = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeReferralDomainLabel(domainLabel);
    if ("error" in normalized) {
      toastError(
        normalized.error === "reserved"
          ? "该域名已被占用，请修改"
          : `域名须为 ${REFERRAL_DOMAIN_LABEL_MIN_LENGTH}–${REFERRAL_DOMAIN_LABEL_MAX_LENGTH} 位小写英文、数字或短横线，首尾不能为短横线`,
      );
      return;
    }
    const { label } = normalized;
    if (updateDomain.isPending || label === overview.data?.domain?.label) return;
    updateDomain.mutate({ label, idempotencyKey: domainUpdateKey.current });
  };
  const selectPageTheme = (themeId: ReferralPageThemeId) => {
    if (themeId === selectedThemeId) return;
    setThemeDraft({ source: currentThemeId, value: themeId });
    themeUpdateKey.current = crypto.randomUUID();
    updatePageTheme.reset();
  };
  const savePageTheme = () => {
    if (
      !overview.data?.enabled ||
      updatePageTheme.isPending ||
      selectedThemeId === currentThemeId
    ) {
      return;
    }
    updatePageTheme.mutate({
      themeId: selectedThemeId,
      idempotencyKey: themeUpdateKey.current,
    });
  };
  const saveSalePrice = (planId: string, billingPeriod: BillingPeriod, inherited: boolean) => {
    const rate = overview.data?.rates.find((item) => item.planId === planId);
    const draftKey = referralPriceDraftKey(planId, billingPeriod);
    if (!rate || pendingSalePriceKeys.current.has(draftKey)) return;
    const values = referralPeriodRate(rate, billingPeriod);
    if (inherited && values.saleInherited) return;
    const draftValue = saleDraftValue(rate, billingPeriod);
    const validationError = inherited
      ? null
      : salePriceValidationError(draftValue, values.costPriceCents, values.platformPriceCents);
    const parsedSalePriceCents = inherited ? null : parseSalePriceCents(draftValue);
    if (validationError !== null || (!inherited && parsedSalePriceCents === null)) {
      setSalePriceErrors((current) => ({
        ...current,
        [draftKey]: validationError ?? "销售价格式无效",
      }));
      return;
    }
    if (parsedSalePriceCents === values.salePriceCents) return;
    let idempotencyKey = priceUpdateKeys.current.get(draftKey);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      priceUpdateKeys.current.set(draftKey, idempotencyKey);
    }
    updateSalePrice.mutate({
      planId,
      billingPeriod,
      salePriceCents: parsedSalePriceCents,
      idempotencyKey,
    });
  };
  const copyLink = async () => {
    if (!overview.data?.shareUrl) return;
    try {
      await navigator.clipboard.writeText(overview.data.shareUrl);
      toastSuccess("专属域名已复制");
    } catch {
      toastError("复制失败，请手动选中专属域名复制");
    }
  };

  const preparePageQuery = (tab: ReferralRecordTab, page: number, pageSize: number) => {
    const queryKey = ["referrals", tab, page, pageSize] as const;
    if (queryClient.getQueryState(queryKey)?.status === "error") {
      queryClient.removeQueries({ queryKey, exact: true });
    }
  };
  const updatePage = (tab: ReferralRecordTab, page: number, pageSize?: number) => {
    const next = { page: Math.max(1, page), pageSize: pageSize ?? pageState[tab].pageSize };
    preparePageQuery(tab, next.page, next.pageSize);
    setPageState((current) => ({
      ...current,
      [tab]: next,
    }));
  };
  const updatePageSize = (tab: ReferralRecordTab, pageSize: number) => {
    preparePageQuery(tab, 1, pageSize);
    setPageState((current) => ({
      ...current,
      [tab]: { page: 1, pageSize },
    }));
  };
  const handleCenterTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = REFERRAL_CENTER_NAV_ITEMS.findIndex((item) => item.id === activeTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight")
      nextIndex = (currentIndex + 1) % REFERRAL_CENTER_NAV_ITEMS.length;
    if (event.key === "ArrowLeft")
      nextIndex =
        (currentIndex - 1 + REFERRAL_CENTER_NAV_ITEMS.length) % REFERRAL_CENTER_NAV_ITEMS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = REFERRAL_CENTER_NAV_ITEMS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = REFERRAL_CENTER_NAV_ITEMS[nextIndex]!;
    onTabChange(nextTab.id);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-referral-center-tab="${nextTab.id}"]`)
      ?.focus();
  };

  const handleRecordTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = REFERRAL_RECORD_TABS.findIndex((item) => item.id === activeRecordTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % REFERRAL_RECORD_TABS.length;
    if (event.key === "ArrowLeft")
      nextIndex = (currentIndex - 1 + REFERRAL_RECORD_TABS.length) % REFERRAL_RECORD_TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = REFERRAL_RECORD_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = REFERRAL_RECORD_TABS[nextIndex]!;
    setActiveRecordTab(nextTab.id);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-referral-record-tab="${nextTab.id}"]`)
      ?.focus();
  };

  const activeTable: TableModel =
    activeRecordTab === "users"
      ? {
          empty: "暂无推荐用户",
          loading: referredUsers.isPending,
          fetching: referredUsers.isFetching,
          error: referredUsers.error,
          pagination: referredUsersPage?.pagination ?? null,
          retry: () => void referredUsers.refetch(),
          headers: ["邮箱", "绑定时间", "订单", "累计佣金"],
          rows: (referredUsersPage?.items ?? []).map((item) => ({
            id: item.id,
            cells: [
              item.email,
              time(item.boundAt),
              String(item.orderCount),
              money(item.commissionCents),
            ],
          })),
        }
      : activeRecordTab === "orders"
        ? {
            empty: "暂无购买记录",
            loading: orders.isPending,
            fetching: orders.isFetching,
            error: orders.error,
            pagination: ordersPage?.pagination ?? null,
            retry: () => void orders.refetch(),
            headers: [
              "用户",
              "套餐",
              "类型",
              "周期",
              "订单金额",
              "累计退款",
              "原佣金",
              "应得佣金",
              "状态",
            ],
            rows: (ordersPage?.items ?? []).map((item) => ({
              id: item.id,
              cells: [
                item.email,
                planLabel(item.planName),
                item.orderType === "machine_purchase" ? "购机" : "续费",
                item.billingPeriod === "annual" ? "365天年付" : "30天月付",
                money(item.orderAmountCents),
                money(item.refundedCents),
                money(item.commissionCents),
                money(item.earnedCommissionCents),
                orderStatus(item.status, item.refundedCents),
              ],
            })),
          }
        : activeRecordTab === "commissions"
          ? {
              empty: "暂无佣金记录",
              loading: commissions.isPending,
              fetching: commissions.isFetching,
              error: commissions.error,
              pagination: commissionsPage?.pagination ?? null,
              retry: () => void commissions.refetch(),
              headers: ["用户", "套餐", "类型", "周期", "释放进度", "原佣金", "应得佣金", "状态"],
              rows: (commissionsPage?.items ?? []).map((item) => ({
                id: item.id,
                cells: [
                  item.email,
                  planLabel(item.planName),
                  item.orderType === "machine_purchase" ? "购机" : "续费",
                  item.billingPeriod === "annual" ? "365天年付" : "30天月付",
                  `${item.releasedInstallments}/${item.installmentCount}`,
                  money(item.commissionCents),
                  money(item.earnedCommissionCents),
                  commissionStatus(item.status),
                ],
              })),
            }
          : activeRecordTab === "settlements"
            ? {
                empty: "暂无月结记录",
                loading: settlements.isPending,
                fetching: settlements.isFetching,
                error: settlements.error,
                pagination: settlementsPage?.pagination ?? null,
                retry: () => void settlements.refetch(),
                headers: ["结算月份", "净结算金额", "入账时间"],
                rows: (settlementsPage?.items ?? []).map((item) => ({
                  id: item.id,
                  cells: [item.month, money(item.amountCents), time(item.createdAt)],
                })),
              }
            : {
                empty: "暂无打款记录",
                loading: payouts.isPending,
                fetching: payouts.isFetching,
                error: payouts.error,
                pagination: payoutsPage?.pagination ?? null,
                retry: () => void payouts.refetch(),
                headers: [
                  "打款月份",
                  "打款单号",
                  "打款金额",
                  "收款账户",
                  "状态",
                  "付款时间",
                  "说明",
                ],
                rows: (payoutsPage?.items ?? []).map((item) => ({
                  id: item.id,
                  cells: [
                    item.month,
                    item.payoutNo ?? "—",
                    money(item.netAmountCents),
                    item.channel === "wechat"
                      ? "历史微信"
                      : item.cardLast4
                        ? [item.bankName, `尾号 ${item.cardLast4}`].filter(Boolean).join(" · ")
                        : "未填写银行卡",
                    payoutStatus(item.status),
                    item.actualPaidAt
                      ? time(item.actualPaidAt)
                      : item.completedAt
                        ? time(item.completedAt)
                        : "—",
                    item.failureCode === "BANK_ACCOUNT_MISSING"
                      ? "未设置银行卡"
                      : item.failureCode === "PAYOUT_PENDING"
                        ? "已有未决打款"
                        : item.failureCode === "CONFIRMED_NOT_PAID"
                          ? "确认未支付成功，等待补发"
                          : item.failureCode === "CANCELLED_BEFORE_PAYMENT"
                            ? "付款前已取消"
                            : "—",
                  ],
                })),
              };
  if (overview.isError) {
    return (
      <div className="cm-panel p-4 text-xs text-red-400">
        {userErrorMessage(overview.error, "推广中心加载失败")}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section>
        <h2 className="text-base font-semibold text-zinc-100">推广中心</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          通过专属域名注册的用户会永久归属你的推广账号，佣金按销售价减成本价计算
        </p>
      </section>

      {overview.data && !overview.data.enabled && (
        <p className="rounded-lg border border-amber-900/60 bg-amber-950/20 px-4 py-3 text-xs text-amber-300">
          推广功能已停用：专属域名不再接受新注册，域名和销售价配置为只读；已有用户的佣金与打款记录不受影响。
        </p>
      )}

      <div
        className="cm-panel grid grid-cols-3 gap-1 p-1"
        role="tablist"
        aria-label="推广中心导航"
        onKeyDown={handleCenterTabKeyDown}
      >
        {REFERRAL_CENTER_NAV_ITEMS.map((item) => {
          const active = item.id === activeTab;
          return (
            <button
              key={item.id}
              id={`referral-center-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`referral-center-panel-${item.id}`}
              tabIndex={active ? 0 : -1}
              data-referral-center-tab={item.id}
              className={`cm-touch-target flex h-10 min-w-0 items-center justify-center rounded-[8px] px-2 text-xs transition-colors ${
                active
                  ? "bg-[#27272a] font-medium text-[#f4f4f5]"
                  : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              }`}
              onClick={() => onTabChange(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div
        id={`referral-center-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`referral-center-tab-${activeTab}`}
        tabIndex={0}
        className="space-y-5 outline-none"
      >
        {activeTab === "overview" && (
          <>
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Summary
                label="可打款余额"
                value={overview.data ? money(overview.data.availablePayoutCents) : "—"}
              />
              <Summary
                label="待结算佣金"
                value={overview.data ? money(overview.data.pendingBalanceCents) : "—"}
              />
              <Summary
                label="已推荐用户"
                value={overview.data ? String(overview.data.referredUsers) : "—"}
              />
              <Summary
                label="累计已打款"
                value={overview.data ? money(overview.data.paidOutCents) : "—"}
              />
            </section>

            {overview.data && overview.data.reservedPayoutCents > 0 && (
              <p className="text-xs text-zinc-500">
                打款预留金额 {money(overview.data.reservedPayoutCents)}
              </p>
            )}
            {overview.data && overview.data.offsetDebtCents > 0 && (
              <p className="text-xs text-amber-400">
                退款调整待抵扣 {money(overview.data.offsetDebtCents)}，后续佣金将先用于抵扣。
              </p>
            )}
            <ReferralBankAccount api={api} />
          </>
        )}

        {activeTab === "domain" &&
          (overview.isPending ? (
            <section className="cm-panel p-6 text-center text-xs text-zinc-500" aria-busy="true">
              正在读取专属推广域名…
            </section>
          ) : overview.data?.domain ? (
            <section className="cm-panel p-4 sm:p-5">
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
                <Globe2 size={14} /> 专属推广域名
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  className="cm-input min-w-0 flex-1 text-xs"
                  readOnly
                  value={overview.data.domain.url}
                  aria-label="专属推广域名"
                />
                <button
                  className="cm-button h-8 gap-1.5 px-3 text-xs"
                  disabled={!overview.data.enabled || !overview.data.shareUrl}
                  onClick={() => void copyLink()}
                >
                  <Copy size={13} /> 复制域名
                </button>
              </div>
              <form className="mt-4" noValidate onSubmit={submitDomain}>
                <label
                  className="text-xs font-medium text-zinc-300"
                  htmlFor="referral-domain-label"
                >
                  域名前缀
                </label>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input
                    id="referral-domain-label"
                    className="cm-input min-w-0 flex-1 text-xs"
                    minLength={REFERRAL_DOMAIN_LABEL_MIN_LENGTH}
                    maxLength={REFERRAL_DOMAIN_LABEL_MAX_LENGTH}
                    pattern="[a-z0-9][a-z0-9-]{4,30}[a-z0-9]"
                    value={domainLabel}
                    disabled={
                      !overview.data.enabled ||
                      !overview.data.domain.editable ||
                      updateDomain.isPending
                    }
                    onChange={(event) => {
                      setDomainDraft({
                        source: domainSourceLabel,
                        value: event.target.value.toLowerCase(),
                      });
                      domainUpdateKey.current = crypto.randomUUID();
                    }}
                  />
                  <button
                    className="cm-button-primary h-8 shrink-0 px-3 text-xs"
                    disabled={
                      !overview.data.enabled ||
                      !overview.data.domain.editable ||
                      updateDomain.isPending ||
                      domainLabel.trim() === overview.data.domain.label
                    }
                  >
                    {updateDomain.isPending ? "保存中…" : "保存域名"}
                  </button>
                </div>
              </form>
              <p className="mt-3 text-[11px] leading-5 text-zinc-500">
                仅支持 {REFERRAL_DOMAIN_LABEL_MIN_LENGTH}–{REFERRAL_DOMAIN_LABEL_MAX_LENGTH}{" "}
                位小写英文、数字和短横线，首尾不能为短横线且至少包含一个英文字母；
                符合格式的名称仍可能已被占用，请修改后重试。已用过的名称永久保留。还可修改{" "}
                {overview.data.domain.remainingRenames} 次
                {overview.data.domain.nextRenameAt
                  ? `，下次可修改时间 ${time(overview.data.domain.nextRenameAt)}`
                  : ""}
                。
              </p>
              {updateDomain.isError && (
                <p className="mt-2 text-xs text-red-400">
                  {userErrorMessage(updateDomain.error, "专属域名更新失败")}
                </p>
              )}
              <ReferralThemeSelector
                currentThemeId={currentThemeId}
                selectedThemeId={selectedThemeId}
                domainUrl={overview.data.domain.url}
                enabled={overview.data.enabled}
                pending={updatePageTheme.isPending}
                error={updatePageTheme.error}
                onChange={selectPageTheme}
                onRestore={() => {
                  setThemeDraft(null);
                  themeUpdateKey.current = crypto.randomUUID();
                  updatePageTheme.reset();
                }}
                onSave={savePageTheme}
              />
            </section>
          ) : (
            <section className="cm-panel p-6 text-center text-xs text-zinc-500">
              专属推广域名暂不可用
            </section>
          ))}

        {activeTab === "overview" && (
          <section className="cm-panel overflow-hidden">
            <PanelTitle title="套餐定价" />
            <p className="border-b border-zinc-800 px-4 py-3 text-[11px] leading-5 text-zinc-500">
              每个套餐可分别设置月付和年付销售价；销售价须介于成本价与平台价之间，佣金会随输入实时计算。
            </p>
            {overview.isPending ? (
              <div
                className="grid gap-3 p-3 xl:grid-cols-2"
                aria-label="套餐定价加载中"
                aria-busy="true"
              >
                {[0, 1].map((index) => (
                  <div
                    key={index}
                    className="h-64 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40"
                  />
                ))}
              </div>
            ) : (overview.data?.rates.length ?? 0) === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-zinc-500">暂无可配置套餐</p>
            ) : (
              <div className="grid gap-3 p-3 xl:grid-cols-2">
                {overview.data!.rates.map((rate) => (
                  <ReferralPriceGroup
                    key={rate.planId}
                    rate={rate}
                    enabled={overview.data!.enabled}
                    saleValue={(billingPeriod) => saleDraftValue(rate, billingPeriod)}
                    pending={(billingPeriod) =>
                      pendingSalePrices.has(referralPriceDraftKey(rate.planId, billingPeriod))
                    }
                    requestError={(billingPeriod) =>
                      salePriceErrors[referralPriceDraftKey(rate.planId, billingPeriod)]
                    }
                    onDraftChange={changeSaleDraft}
                    onUndo={clearSaleDraft}
                    onSave={saveSalePrice}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {activeTab === "records" && (
          <section className="cm-panel overflow-hidden">
            <div className="overflow-x-auto border-b border-zinc-800">
              <div
                role="tablist"
                aria-label="推广记录"
                className="flex min-w-max px-2"
                onKeyDown={handleRecordTabKeyDown}
              >
                {REFERRAL_RECORD_TABS.map((item) => {
                  const active = item.id === activeRecordTab;
                  return (
                    <button
                      key={item.id}
                      id={`referral-record-tab-${item.id}`}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-controls="referral-record-panel"
                      tabIndex={active ? 0 : -1}
                      data-referral-record-tab={item.id}
                      className={`relative h-10 px-3 text-xs transition-colors after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full ${
                        active
                          ? "text-zinc-100 after:bg-[var(--cm-accent)]"
                          : "text-zinc-500 after:bg-transparent hover:text-zinc-200"
                      }`}
                      onClick={() => setActiveRecordTab(item.id)}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div
              id="referral-record-panel"
              role="tabpanel"
              aria-labelledby={`referral-record-tab-${activeRecordTab}`}
              tabIndex={0}
            >
              <DataTable
                title={REFERRAL_RECORD_TABS.find((item) => item.id === activeRecordTab)!.label}
                empty={activeTable.empty}
                loading={activeTable.loading}
                fetching={activeTable.fetching}
                error={activeTable.error}
                headers={activeTable.headers}
                rows={activeTable.rows}
                pagination={activeTable.pagination}
                onRetry={activeTable.retry}
                onPageChange={(page) =>
                  updatePage(activeRecordTab, page, activeTable.pagination?.pageSize)
                }
                onPageSizeChange={(pageSize) => updatePageSize(activeRecordTab, pageSize)}
              />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="cm-panel p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-2 text-xl font-semibold text-zinc-100">{value}</p>
    </div>
  );
}

function PanelTitle({ title }: { title: string }) {
  return (
    <div className="border-b border-zinc-800 px-4 py-3 text-xs font-medium text-zinc-200">
      {title}
    </div>
  );
}

function DataTable(props: {
  title: string;
  empty: string;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  headers: string[];
  rows: TableRow[];
  pagination: ReferralPagination | null;
  onRetry: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  return (
    <div aria-busy={props.fetching}>
      {props.error !== null && props.error !== undefined && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-red-950/60 bg-red-950/20 px-4 py-2.5 text-xs text-red-300"
        >
          <span>
            {userErrorMessage(props.error, `${props.title}加载失败`)}
            {props.pagination ? "，已保留上次加载的内容" : ""}
          </span>
          <button
            type="button"
            className="cm-button h-7 shrink-0 px-2 text-xs"
            disabled={props.fetching}
            onClick={props.onRetry}
          >
            {props.fetching ? "重试中…" : "重试"}
          </button>
        </div>
      )}
      {props.loading && !props.pagination ? (
        <div className="h-24" />
      ) : props.error && !props.pagination ? null : props.rows.length === 0 ? (
        <p className="p-4 text-xs text-zinc-500">{props.empty}</p>
      ) : (
        <div className={`overflow-x-auto transition-opacity ${props.fetching ? "opacity-60" : ""}`}>
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                {props.headers.map((header) => (
                  <th key={header} className="px-4 py-2 font-medium">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {props.rows.map((row) => (
                <tr key={row.id}>
                  {row.cells.map((cell, cellIndex) => (
                    <td key={cellIndex} className="whitespace-nowrap px-4 py-2.5 text-zinc-300">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {props.pagination && (
        <PaginationControls
          key={`${props.title}:${props.pagination.page}:${props.pagination.pageSize}`}
          pagination={props.pagination}
          fetching={props.fetching}
          onPageChange={props.onPageChange}
          onPageSizeChange={props.onPageSizeChange}
        />
      )}
    </div>
  );
}

type PageItem = number | "start-ellipsis" | "end-ellipsis";

function pageItems(page: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, "end-ellipsis", totalPages];
  if (page >= totalPages - 3) {
    return [
      1,
      "start-ellipsis",
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ];
  }
  return [1, "start-ellipsis", page - 1, page, page + 1, "end-ellipsis", totalPages];
}

function PaginationControls(props: {
  pagination: ReferralPagination;
  fetching: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const { page, pageSize, total, totalPages } = props.pagination;
  const [jumpPage, setJumpPage] = useState(String(page));

  const submitJump = (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(jumpPage);
    if (!Number.isInteger(parsed)) return;
    props.onPageChange(Math.min(totalPages, Math.max(1, parsed)));
  };

  return (
    <div className="flex flex-col gap-3 border-t border-zinc-800 px-3 py-3 text-xs text-zinc-500 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-2">
        <span>{props.fetching ? "正在加载…" : `共 ${total} 条`}</span>
        <label className="flex items-center gap-1.5">
          <span>每页</span>
          <select
            className="cm-input h-7 w-[62px] px-2 py-0 text-xs"
            aria-label="每页条数"
            value={pageSize}
            disabled={props.fetching}
            onChange={(event) => props.onPageSizeChange(Number(event.target.value))}
          >
            {[10, 20, 50].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          <span>条</span>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className="cm-button h-7 px-2 text-xs"
          disabled={page <= 1 || props.fetching}
          onClick={() => props.onPageChange(page - 1)}
        >
          上一页
        </button>
        <div className="flex items-center gap-1" aria-label="分页页码">
          {pageItems(page, totalPages).map((item) =>
            typeof item === "number" ? (
              <button
                key={item}
                type="button"
                className={`${item === page ? "cm-button-primary" : "cm-button"} h-7 min-w-7 px-2 text-xs`}
                aria-current={item === page ? "page" : undefined}
                disabled={props.fetching}
                onClick={() => props.onPageChange(item)}
              >
                {item}
              </button>
            ) : (
              <span key={item} className="px-1 text-zinc-600" aria-hidden="true">
                …
              </span>
            ),
          )}
        </div>
        <button
          type="button"
          className="cm-button h-7 px-2 text-xs"
          disabled={page >= totalPages || props.fetching}
          onClick={() => props.onPageChange(page + 1)}
        >
          下一页
        </button>
        <form className="ml-1 flex items-center gap-1.5" onSubmit={submitJump}>
          <span>跳至</span>
          <input
            className="cm-input h-7 w-14 px-2 py-0 text-center text-xs"
            aria-label="跳转页码"
            inputMode="numeric"
            min={1}
            max={totalPages}
            value={jumpPage}
            disabled={props.fetching}
            onChange={(event) => setJumpPage(event.target.value.replace(/\D/g, ""))}
          />
          <span>页</span>
          <button
            type="submit"
            className="cm-button h-7 px-2 text-xs"
            disabled={!jumpPage || props.fetching}
          >
            跳转
          </button>
        </form>
      </div>
    </div>
  );
}
