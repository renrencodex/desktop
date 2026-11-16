"use client";

import { Link, useClientHost, useRouter, useSearchParams } from "../host";
import {
  ArrowLeft,
  Bell,
  Gift,
  Info,
  LogOut,
  ReceiptText,
  RefreshCw,
  Settings2,
  UserRound,
  WalletCards,
} from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";

import { logout } from "../lib/session";
import { useWorkbenchRuntime } from "../components/workbench-runtime-context";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useDesktopUpdate } from "../components/DesktopUpdateProvider";
import {
  accountInitial,
  accountStatusLabel,
  DEFAULT_SETTINGS_RETURN_PATH,
  normalizeReferralCenterTab,
  normalizeSettingsReturnPath,
  referralSettingsPathWithTab,
  settingsPathWithReturnTo,
  REFERRAL_CENTER_TAB_PARAM,
  SETTINGS_PATHS,
  SETTINGS_RETURN_PARAM,
  type ReferralCenterTab,
  type SettingsSection,
} from "../lib/settings";
import { useAuthStore } from "../stores/auth";
import { useWorkbenchStore } from "../stores/workbench";
import { NotificationsSettings, OrdersSettings, WalletSettings } from "./BillingSettings";
import { ReferralSettings } from "./ReferralSettings";

const SETTINGS_MENU = [
  { id: "account", label: "账户", href: SETTINGS_PATHS.account, icon: UserRound },
  { id: "wallet", label: "余额与充值", href: SETTINGS_PATHS.wallet, icon: WalletCards },
  { id: "orders", label: "订单", href: SETTINGS_PATHS.orders, icon: ReceiptText },
  { id: "notifications", label: "消息", href: SETTINGS_PATHS.notifications, icon: Bell },
  { id: "referrals", label: "推广中心", href: SETTINGS_PATHS.referrals, icon: Gift },
  { id: "about", label: "关于与更新", href: SETTINGS_PATHS.about, icon: Info },
] as const;

export function SettingsPage({ section }: { section: SettingsSection }) {
  const runtime = useWorkbenchRuntime();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = normalizeSettingsReturnPath(searchParams?.get(SETTINGS_RETURN_PARAM));
  const returnHref = returnTo ?? DEFAULT_SETTINGS_RETURN_PATH;
  const referralTabValue = searchParams?.get(REFERRAL_CENTER_TAB_PARAM);
  const referralTab = normalizeReferralCenterTab(referralTabValue);
  const settingsSearch = searchParams?.toString() ?? "";
  const user = useAuthStore((state) => state.user);
  const hasReferralProgram = user?.referralProgramExists ?? user?.referralEnabled;
  const menu = SETTINGS_MENU.filter((item) => item.id !== "referrals" || hasReferralProgram);
  useEffect(() => router.prefetch(returnHref), [returnHref, router]);
  useEffect(() => {
    if (
      section !== "referrals" ||
      referralTabValue === null ||
      referralTabValue === undefined ||
      referralTabValue === referralTab
    )
      return;
    router.replace(referralSettingsPathWithTab(referralTab, settingsSearch));
  }, [referralTab, referralTabValue, router, section, settingsSearch]);
  const changeReferralTab = (nextTab: ReferralCenterTab) => {
    if (nextTab === referralTab) return;
    router.push(referralSettingsPathWithTab(nextTab, settingsSearch));
  };
  const restoreConsole = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (runtime?.restoreCached(returnHref)) event.preventDefault();
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-settings-section={section}>
      <div className="cm-toolbar relative min-h-12 shrink-0 py-2 sm:min-h-9 sm:py-0">
        <Link
          href={returnHref}
          onClick={restoreConsole}
          className="cm-button-primary cm-settings-back-link h-8 gap-1.5 px-2.5 text-[11px] sm:h-6 sm:px-2"
          aria-label="返回控制台"
        >
          <ArrowLeft size={12} className="size-3 shrink-0" aria-hidden="true" />
          返回控制台
        </Link>
        <div className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-2">
          <Settings2 size={14} className="text-zinc-500" />
          <h1 className="text-xs font-medium text-zinc-200">用户中心</h1>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          aria-label="设置菜单"
          className="flex w-full shrink-0 gap-1 overflow-x-auto border-b border-zinc-800 p-1.5 sm:w-[200px] sm:flex-col sm:overflow-x-visible sm:border-r sm:border-b-0 sm:p-2"
          style={{ backgroundColor: "var(--cm-surface-sidebar)" }}
        >
          {menu.map((item) => {
            const Icon = item.icon;
            const active = item.id === section;
            return (
              <Link
                key={item.id}
                href={settingsPathWithReturnTo(item.href, returnTo)}
                replace
                aria-current={active ? "page" : undefined}
                className={`cm-touch-target cm-settings-menu-item flex h-8 shrink-0 items-center gap-2 rounded-[8px] px-2.5 text-xs transition-colors ${
                  active
                    ? "bg-[var(--cm-accent-muted)] font-medium text-zinc-100"
                    : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                }`}
              >
                <Icon size={14} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3 sm:p-5 lg:p-6">
          <div className="mx-auto w-full max-w-[960px]">
            {section === "account" && <AccountSettings />}
            {section === "wallet" && <WalletSettings />}
            {section === "orders" && <OrdersSettings />}
            {section === "notifications" && <NotificationsSettings />}
            {section === "referrals" && hasReferralProgram && (
              <ReferralSettings activeTab={referralTab} onTabChange={changeReferralTab} />
            )}
            {section === "referrals" && !hasReferralProgram && (
              <div className="cm-panel p-4 text-xs text-zinc-500">推广功能尚未开通</div>
            )}
            {section === "about" && <AboutSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

function AboutSettings() {
  const { platformKind } = useClientHost();
  const update = useDesktopUpdate();
  const mobile = platformKind === "tauri-mobile";
  const checking = update.checkStatus === "checking";
  const status = !update.supported
    ? mobile
      ? "Android 客户端暂不支持应用内自升级"
      : "当前平台暂不支持客户端自升级"
    : update.checkStatus === "current"
      ? "当前已是最新版本"
      : update.availableUpdate
        ? `发现新版本 ${update.availableUpdate.version}`
        : update.error
          ? update.error
          : "启动后会自动检查更新，也可以立即手动检查";

  return (
    <div className="space-y-5">
      <section>
        <h2 className="text-base font-semibold text-zinc-100">关于与更新</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          {mobile ? "查看 Android 客户端信息" : "查看版本并检查桌面客户端更新"}
        </p>
      </section>

      <section className="cm-panel p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-zinc-100">
              {mobile ? "人人Codex Android" : "人人Codex Desktop"}
            </h3>
            <p className="mt-1 text-xs text-zinc-500">
              {update.currentVersion
                ? `当前版本 ${update.currentVersion}`
                : update.supported
                  ? "正在读取当前版本…"
                  : mobile
                    ? "版本信息可在 Android 系统应用详情中查看"
                    : "当前版本未知"}
            </p>
            <p
              className={`mt-2 text-xs leading-5 ${update.error ? "text-red-400" : "text-zinc-400"}`}
            >
              {status}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {update.availableUpdate && (
              <button type="button" className="cm-button-primary" onClick={update.showAvailable}>
                查看更新
              </button>
            )}
            {update.supported && (
              <button
                type="button"
                className="cm-button-primary"
                disabled={checking || update.installState.stage !== "idle"}
                onClick={() => void update.check()}
              >
                <RefreshCw size={12} className={checking ? "animate-spin" : undefined} />
                {checking ? "正在检查…" : "检查更新"}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function AccountSettings() {
  const runtime = useWorkbenchRuntime();
  const user = useAuthStore((state) => state.user);
  const dirtyFileCount = useWorkbenchStore((state) => state.dirtyFileCount);
  const [loggingOut, setLoggingOut] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  if (!user) return null;

  const statusTone =
    user.status === "active"
      ? "bg-emerald-500/10 text-emerald-500"
      : user.status === "suspended"
        ? "bg-amber-500/10 text-amber-500"
        : "bg-red-500/10 text-red-500";

  const signOut = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      // logout() 会在 finally 中清理本地会话，外层认证布局负责替换到登录页。
    }
  };

  const requestSignOut = () => {
    if (dirtyFileCount > 0 || runtime?.hasUnsaved) {
      setConfirmSignOut(true);
      return;
    }
    void signOut();
  };

  return (
    <div className="space-y-5">
      <section>
        <h2 className="text-base font-semibold text-zinc-100">账户</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500">查看当前登录账户与会话信息</p>
      </section>

      <section className="cm-panel overflow-hidden">
        <div className="flex items-center gap-4 border-b border-zinc-800 p-4 sm:p-5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[8px] bg-[var(--cm-accent)] text-base font-semibold text-[var(--cm-accent-fg)]">
            {accountInitial(user)}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium text-zinc-100">{user.displayName}</h3>
            <p className="mt-1 truncate text-xs text-zinc-500">{user.email}</p>
          </div>
          <span
            className={`ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[10px] ${statusTone}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {accountStatusLabel(user.status)}
          </span>
        </div>

        <dl className="divide-y divide-zinc-800">
          <AccountField label="昵称" value={user.displayName} />
          <AccountField label="邮箱" value={user.email} />
          <AccountField label="账户状态" value={accountStatusLabel(user.status)} />
        </dl>
      </section>

      <section className="cm-panel p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-zinc-100">登录会话</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              退出后将清除当前设备上的登录状态，需要重新登录才能继续使用
            </p>
          </div>
          <button
            type="button"
            className="cm-button-danger shrink-0"
            disabled={loggingOut}
            onClick={requestSignOut}
          >
            <LogOut size={12} />
            {loggingOut ? "正在退出…" : "退出登录"}
          </button>
        </div>
      </section>

      <ConfirmDialog
        open={confirmSignOut}
        title="退出登录"
        body="还有未保存文件。退出登录会丢失这些内容，确定继续吗？"
        confirmLabel="放弃并退出"
        busy={loggingOut}
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={() => {
          setConfirmSignOut(false);
          void signOut();
        }}
      />
    </div>
  );
}

function AccountField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center sm:px-5">
      <dt className="text-[11px] text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-all text-xs text-zinc-200">{value}</dd>
    </div>
  );
}
