/** Cursor 风格认证工作台：标题栏 + 计算资源侧栏 + 主画布 + 状态栏。 */
"use client";

import type { Machine, Workspace, WorkspaceGitImportStatus } from "@cloud-machine/api-client";
import {
  DEFAULT_WORKSPACE_DISPLAY_NAME,
  workspaceRootForRegistrations,
} from "@cloud-machine/client-contracts";
import {
  beginWorkspaceNavigation,
  clearWorkspaceNavigationPerformance,
  mergeMachineDetailSnapshot,
} from "@cloud-machine/workspace-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useClientHost, usePathname, useRouter, useSearchParams } from "../host";
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  FileCode2,
  Folder,
  FolderPlus,
  Laptop,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api } from "../lib/api";
import { lifecycleLabel, regionLabel } from "../lib/display-labels";
import { useUnsavedNavigationGuard } from "../lib/navigation-guard";
import {
  preloadDirectoryWorkbench,
  WorkbenchRuntimeProvider,
  RetainedWorkspaces,
  useWorkbenchRuntime,
} from "./WorkbenchRuntime";
import { restoreSession } from "../lib/session";
import {
  cacheMachineNames,
  finishMachineTitleBootstrap,
  readMachineTitleName,
} from "../lib/machine-title";
import { SHORTCUT_SIDEBAR, SHORTCUTS } from "../lib/shortcuts";
import { prewarmTerminalRenderer } from "../lib/terminal-renderer";
import {
  accountInitial,
  isSettingsPath,
  settingsPathWithReturnTo,
  SETTINGS_PATHS,
  SETTINGS_RETURN_PARAM,
} from "../lib/settings";
import { THEME_DEFINITIONS } from "../lib/themes";
import { dispatchWorkbenchCommand, type MachineView } from "../lib/workbench-commands";
import { useAuthStore } from "../stores/auth";
import { useThemeStore } from "../stores/theme";
import { useWorkbenchStore } from "../stores/workbench";
import { userErrorMessage } from "../lib/user-error";
import { isWorkspaceRoute } from "../lib/workspace-navigation";
import { workspaceLocation } from "../lib/workspace-cache";
import { useBackDismiss, useOnlineStatus, useResponsiveViewport } from "../lib/responsive";
import { toastError, toastSuccess } from "../stores/toast";
import { CommandPalette, type CommandPaletteItem } from "./CommandPalette";
import { BrandLogo } from "./BrandLogo";
import { ComputeResourcesIcon } from "./ComputeResourcesIcon";
import { MobileTitlebarPortalProvider, MobileTitlebarPortalTarget } from "./MobileTitlebarPortal";
import { NotificationCenter } from "./NotificationCenter";
import { ThemeMenu } from "./ThemeMenu";

export { ThemeMenu };
import { RenameDialog } from "./RenameDialog";
import { ResponsiveWorkbenchShell } from "./ResponsiveWorkbenchShell";
import { SidebarMachineMetrics } from "./SidebarMachineMetrics";
import { LifecycleIndicator } from "./StatusBadge";
import { WorkspaceDeleteDialog } from "./WorkspaceDeleteDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const DEFAULT_NEW_PROJECT_DIRECTORY = "default-project";
const DOCUMENTATION_URL = "https://docs.renrencodex.com";

function gitRepositoryName(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const last = url.pathname
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.git$/i, "");
    if (!last) return null;
    const safe = decodeURIComponent(last)
      .trim()
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100);
    return safe && safe !== "." && safe !== ".." ? safe : null;
  } catch {
    return null;
  }
}

const GIT_IMPORT_STAGE_LABELS = {
  queued: "等待拉取",
  connecting: "正在连接电脑",
  cloning: "正在拉取代码",
  publishing: "正在创建项目",
  verifying: "正在核实项目",
  ready: "已完成",
  cancelled: "已取消",
  failed: "拉取失败",
} as const;

export function FullScreenLoading() {
  return <div aria-hidden="true" className="h-full bg-[var(--cm-surface-canvas)]" />;
}

export function AuthedLayout({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const userId = useAuthStore((s) => s.user?.id);
  const workbenchHydrated = useWorkbenchStore((state) => state.hydrated);
  const hydrateWorkbench = useWorkbenchStore((state) => state.hydrate);
  const router = useRouter();
  const queryClient = useQueryClient();

  useEffect(() => hydrateWorkbench(), [hydrateWorkbench]);

  useEffect(() => {
    clearWorkspaceNavigationPerformance();
  }, [userId]);

  useEffect(() => {
    if (status === "booting") void restoreSession();
  }, [status]);

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

  // 登录成功后预热终端渲染器，并在空闲时加载工作台与终端组件。
  useEffect(() => {
    if (status !== "authenticated") return;
    prewarmTerminalRenderer();
    if (userId)
      void queryClient.prefetchQuery({
        queryKey: ["cli-store-catalog", userId],
        queryFn: () => api.cliStore.catalog(),
        staleTime: 5 * 60_000,
      });
    const preload = () => preloadDirectoryWorkbench();
    if ("requestIdleCallback" in window) {
      const handle = window.requestIdleCallback(preload, { timeout: 1_500 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = globalThis.setTimeout(preload, 250);
    return () => globalThis.clearTimeout(handle);
  }, [queryClient, status, userId]);

  if (status !== "authenticated" || !workbenchHydrated) {
    return <FullScreenLoading />;
  }
  return (
    <WorkbenchRuntimeProvider key={userId}>
      <MobileTitlebarPortalProvider>
        <Shell>{children}</Shell>
      </MobileTitlebarPortalProvider>
    </WorkbenchRuntimeProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const host = useClientHost();
  const runtime = useWorkbenchRuntime();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  const settingsCenter = isSettingsPath(pathname);
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const sidebarCollapsed = useWorkbenchStore((s) => s.sidebarCollapsed);
  const sidebarSize = useWorkbenchStore((s) => s.sidebarSize);
  const mobileSidebarOpen = useWorkbenchStore((s) => s.mobileSidebarOpen);
  const dirtyFileCount = useWorkbenchStore((s) => s.dirtyFileCount);
  const toggleSidebar = useWorkbenchStore((s) => s.toggleSidebar);
  const setSidebarCollapsed = useWorkbenchStore((s) => s.setSidebarCollapsed);
  const setSidebarSize = useWorkbenchStore((s) => s.setSidebarSize);
  const setMobileSidebarOpen = useWorkbenchStore((s) => s.setMobileSidebarOpen);
  const setTheme = useThemeStore((state) => state.setTheme);
  const { isCompact, isPhone } = useResponsiveViewport();
  const online = useOnlineStatus();
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const releaseMobileSidebarForNavigation = useBackDismiss(
    isCompact && !settingsCenter && mobileSidebarOpen,
    () => setMobileSidebarOpen(false),
    "resource-sidebar",
  );
  const closeMobileSidebarForNavigation = useCallback(() => {
    releaseMobileSidebarForNavigation();
    setMobileSidebarOpen(false);
  }, [releaseMobileSidebarForNavigation, setMobileSidebarOpen]);
  const confirmNavigation = useCallback(
    (destination = pathname) => {
      const remainsInRetainedShell =
        /^\/(machines|settings)(\/|$)/.test(destination) ||
        (host.platformKind === "tauri-desktop" && destination === "/");
      if (runtime)
        return (
          !runtime.hasUnsaved ||
          remainsInRetainedShell ||
          window.confirm("离开控制台会丢失未保存文件，确定继续吗？")
        );
      return (
        dirtyFileCount === 0 ||
        window.confirm(
          `还有 ${dirtyFileCount} 个文件未保存。离开当前项目或电脑会丢失这些修改，确定继续吗？`,
        )
      );
    },
    [dirtyFileCount, host.platformKind, runtime, pathname],
  );
  useUnsavedNavigationGuard(runtime ? Number(runtime.hasUnsaved) : dirtyFileCount, () =>
    confirmNavigation(window.location.pathname),
  );
  const toggleResponsiveSidebar = useCallback(() => {
    if (settingsCenter) return;
    if (isCompact) {
      setMobileSidebarOpen(!mobileSidebarOpen);
    } else {
      toggleSidebar();
    }
  }, [isCompact, mobileSidebarOpen, setMobileSidebarOpen, settingsCenter, toggleSidebar]);

  useEffect(() => {
    if (!isCompact || settingsCenter) setMobileSidebarOpen(false);
  }, [isCompact, setMobileSidebarOpen, settingsCenter]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "b") return;
      if (settingsCenter) return;
      event.preventDefault();
      toggleResponsiveSidebar();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsCenter, toggleResponsiveSidebar]);

  // "?"（Shift+/）打开快捷键帮助；输入框、编辑器与终端内不拦截。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      setShortcutHelpOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (dirtyFileCount === 0 && !runtime?.hasUnsaved) return;
    const confirmLinkNavigation = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const element = event.target instanceof Element ? event.target : null;
      const anchor = element?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.download || anchor.target === "_blank") return;
      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        destination.href === window.location.href
      ) {
        return;
      }
      if (settingsCenter && isSettingsPath(destination.pathname)) return;
      if (!confirmNavigation(destination.pathname)) event.preventDefault();
    };
    document.addEventListener("click", confirmLinkNavigation, true);
    return () => document.removeEventListener("click", confirmLinkNavigation, true);
  }, [confirmNavigation, dirtyFileCount, settingsCenter, runtime?.hasUnsaved]);

  useEffect(() => {
    if (dirtyFileCount === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyFileCount]);

  const machinesQuery = useQuery({
    queryKey: ["machines"],
    queryFn: () => api.machines.list(),
    enabled: !settingsCenter,
    refetchInterval: settingsCenter ? false : 5000,
  });
  const machineId = /^\/machines\/([^/]+)/.exec(pathname)?.[1];
  const currentMachine = machinesQuery.data?.find((machine) => machine.id === machineId) ?? null;
  const titleAccountId = useAuthStore((state) => state.user?.id);

  useEffect(() => {
    if (titleAccountId && machinesQuery.data) cacheMachineNames(titleAccountId, machinesQuery.data);
  }, [titleAccountId, machinesQuery.data]);

  useEffect(() => {
    if (!machineId || machineId === "new" || !titleAccountId) {
      finishMachineTitleBootstrap();
      return;
    }
    const machineName =
      currentMachine?.name.trim() ??
      (machinesQuery.isSuccess ? null : readMachineTitleName(titleAccountId, machineId));

    const title = machineName ? `${machineName} · 人人Codex` : "人人Codex";
    const applyTitle = () => {
      if (document.title !== title) document.title = title;
    };
    applyTitle();

    // Next.js 客户端导航会在页面提交后更新静态 metadata；保持当前电脑名称优先。
    const observer = new MutationObserver(applyTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    finishMachineTitleBootstrap();
    return () => {
      observer.disconnect();
      if (document.title === title) document.title = "人人Codex";
    };
  }, [currentMachine?.name, machineId, titleAccountId, machinesQuery.isSuccess]);

  const sidebarOpen = isCompact ? mobileSidebarOpen : !sidebarCollapsed;
  const currentHref = `${pathname}${search ? `?${search}` : ""}`;
  const settingsAccountHref = settingsPathWithReturnTo(
    SETTINGS_PATHS.account,
    settingsCenter ? searchParams?.get(SETTINGS_RETURN_PARAM) : currentHref,
  );
  const settingsNotificationsHref = settingsPathWithReturnTo(
    SETTINGS_PATHS.notifications,
    settingsCenter ? searchParams?.get(SETTINGS_RETURN_PARAM) : currentHref,
  );
  const openDocumentation = useCallback(() => {
    void host.platform
      .openExternal(DOCUMENTATION_URL)
      .catch(() => toastError("无法打开帮助文档，请稍后重试"));
  }, [host.platform]);

  const isMachineWorkspace = Boolean(machineId);
  const commands = useMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = [
      ...(runtime?.recent ?? []).map((entry) => ({
        id: `recent:${entry.href}`,
        title: entry.label,
        category: "最近访问",
        keywords: entry.href,
        run: () => {
          if (runtime?.navigateCached(entry.href)) return;
          if (`${window.location.pathname}${window.location.search}` !== entry.href)
            router.push(entry.href);
        },
      })),
      {
        id: "navigation.machines",
        title: "转到：电脑概览",
        category: "导航",
        keywords: "machines dashboard 首页",
        run: () => {
          if (confirmNavigation()) router.push("/machines");
        },
      },
      {
        id: "navigation.machine-new",
        title: "新建电脑",
        category: "导航",
        keywords: "create machine",
        run: () => {
          if (confirmNavigation()) router.push("/machines/new");
        },
      },
      {
        id: "navigation.settings-account",
        title: "转到：账户设置",
        category: "导航",
        keywords: "settings account 账号 账户",
        run: () => {
          if (confirmNavigation()) router.push(settingsAccountHref);
        },
      },
      {
        id: "view.sidebar",
        title: "切换资源侧栏",
        category: "视图",
        shortcut: SHORTCUT_SIDEBAR,
        keywords: "sidebar panel",
        enabled: !settingsCenter,
        run: toggleResponsiveSidebar,
      },
      {
        id: "help.documentation",
        title: "帮助：打开用户文档",
        category: "帮助",
        keywords: "documentation docs guide help 文档 指南",
        run: openDocumentation,
      },
      {
        id: "help.shortcuts",
        title: "帮助：键盘快捷键",
        category: "帮助",
        shortcut: "?",
        keywords: "keyboard shortcuts help 快捷键",
        run: () => setShortcutHelpOpen(true),
      },
      ...THEME_DEFINITIONS.map((theme) => ({
        id: `theme.${theme.id}`,
        title: `主题：${theme.name}`,
        category: "外观",
        keywords: `${theme.description} theme`,
        run: () => setTheme(theme.id),
      })),
    ];
    const views: Array<{ view: MachineView; title: string; keywords: string }> = [
      { view: "overview", title: "电脑视图：面板", keywords: "overview metrics" },
      { view: "ports", title: "电脑视图：端口", keywords: "ports preview" },
      { view: "snapshots", title: "电脑视图：备份", keywords: "snapshots" },
    ];
    for (const view of views) {
      items.push({
        id: `machine.view.${view.view}`,
        title: view.title,
        category: "电脑",
        enabled: isMachineWorkspace,
        keywords: view.keywords,
        run: () => dispatchWorkbenchCommand({ type: "machine.view", view: view.view }),
      });
    }
    return items;
  }, [
    runtime,
    confirmNavigation,
    isMachineWorkspace,
    openDocumentation,
    router,
    setTheme,
    settingsAccountHref,
    settingsCenter,
    toggleResponsiveSidebar,
  ]);

  return (
    <div
      className="cm-app-shell cm-canvas cm-workbench-backdrop grid text-zinc-100"
      data-viewport={isPhone ? "phone" : isCompact ? "tablet" : "desktop"}
    >
      <header
        data-tauri-drag-region
        className="cm-titlebar relative flex items-center border-b border-zinc-800 px-2"
        style={{ background: "var(--cm-surface-titlebar)" }}
      >
        {!settingsCenter && (
          <button
            type="button"
            className="cm-icon-button"
            onClick={toggleResponsiveSidebar}
            title={sidebarOpen ? "收起资源侧栏" : "展开资源侧栏"}
            aria-label={sidebarOpen ? "收起资源侧栏" : "展开资源侧栏"}
          >
            {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
        )}
        <Link
          href="/"
          aria-label="返回首页"
          className="ml-1 flex items-center gap-2 text-xs font-semibold text-zinc-200 transition-colors hover:text-zinc-100"
        >
          <BrandLogo className="hidden sm:inline-flex" />
        </Link>
        <MobileTitlebarPortalTarget className="absolute left-1/2 flex min-w-0 -translate-x-1/2 items-center sm:hidden" />
        <CommandPalette commands={commands} />
        {/* 手机端没有命令面板占位，改用弹性间隔把右侧控件顶到标题栏边缘。 */}
        <div className="flex-1 sm:hidden" />
        {isPhone && currentMachine && (
          <div
            className="flex items-center gap-2 text-[10px] text-zinc-500"
            title={currentMachine.agentConnectionState === "connected" ? "通信正常" : "通信中断"}
          >
            {dirtyFileCount > 0 && <span className="text-amber-400">● {dirtyFileCount}</span>}
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                currentMachine.agentConnectionState === "connected"
                  ? "bg-emerald-400"
                  : "bg-zinc-600"
              }`}
            />
          </div>
        )}
        <button
          type="button"
          className="cm-touch-square cm-icon-button"
          title="打开帮助文档"
          aria-label="打开帮助文档"
          onClick={openDocumentation}
        >
          <CircleHelp size={15} aria-hidden="true" />
        </button>
        <NotificationCenter
          onViewAll={() => {
            if (confirmNavigation(SETTINGS_PATHS.notifications))
              router.push(settingsNotificationsHref);
          }}
        />
        <ThemeMenu />
        {/* 触屏下 cm-touch-square 把按钮撑到 40px 触摸区，头像另用固定尺寸，避免占满标题栏。 */}
        <button
          type="button"
          className="cm-touch-square group ml-1 flex h-6 w-6 items-center justify-center focus-visible:outline-none"
          title="打开用户中心"
          aria-label="打开用户中心"
          aria-current={settingsCenter ? "page" : undefined}
          onClick={() => {
            if (!settingsCenter && confirmNavigation()) router.push(settingsAccountHref);
          }}
        >
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors group-focus-visible:ring-2 group-focus-visible:ring-[var(--cm-accent)] ${
              settingsCenter
                ? "bg-[var(--cm-accent)] text-[var(--cm-accent-fg)]"
                : "bg-zinc-800 text-zinc-300 group-hover:bg-zinc-700 group-hover:text-zinc-100"
            }`}
          >
            {accountInitial(user)}
          </span>
        </button>
        {host.windowControls}
      </header>

      <div className="cm-app-content relative flex min-h-0">
        {host.sessionNotice}
        {!online && (
          <div
            role="alert"
            className="absolute inset-x-0 top-0 z-40 animate-in border-b px-3 py-1.5 text-center text-[11px] cm-banner-warning slide-in-from-top-1 fade-in duration-150"
          >
            网络连接已断开，操作将在恢复后继续
          </div>
        )}
        <ResponsiveWorkbenchShell
          isMobile={isCompact}
          mobileSidebarOpen={!settingsCenter && mobileSidebarOpen}
          sidebarCollapsed={settingsCenter || sidebarCollapsed}
          sidebarSize={sidebarSize}
          onCloseMobileSidebar={() => setMobileSidebarOpen(false)}
          onDesktopSidebarLayoutChange={(nextSize) => {
            if (settingsCenter) return;
            if (nextSize < 1) {
              if (!sidebarCollapsed) setSidebarCollapsed(true);
            } else {
              if (sidebarCollapsed) setSidebarCollapsed(false);
              setSidebarSize(nextSize);
            }
          }}
          desktopSidebar={
            <aside className="cm-sidebar-surface flex h-full min-w-0 flex-col">
              <MachineExplorer
                machines={machinesQuery.data ?? []}
                metricsActive={!settingsCenter && sidebarOpen}
                pending={machinesQuery.isPending}
                error={machinesQuery.isError}
                confirmNavigation={confirmNavigation}
                onNavigate={() => setMobileSidebarOpen(false)}
                replaceNavigation={false}
              />
            </aside>
          }
          mobileSidebar={
            <MachineExplorer
              machines={machinesQuery.data ?? []}
              metricsActive={!settingsCenter && sidebarOpen}
              pending={machinesQuery.isPending}
              error={machinesQuery.isError}
              confirmNavigation={confirmNavigation}
              onNavigate={closeMobileSidebarForNavigation}
              replaceNavigation
            />
          }
        >
          <RetainedWorkspaces>{children}</RetainedWorkspaces>
        </ResponsiveWorkbenchShell>
      </div>

      <StatusBar machine={currentMachine} />

      <Dialog open={shortcutHelpOpen} onOpenChange={setShortcutHelpOpen}>
        <DialogContent className="max-w-md border-zinc-800 bg-zinc-900 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-xs">键盘快捷键</DialogTitle>
            <DialogDescription className="sr-only">可用的键盘快捷键列表</DialogDescription>
          </DialogHeader>
          <ul className="divide-y divide-zinc-800">
            {SHORTCUTS.map((shortcut) => (
              <li key={shortcut.keys} className="flex items-center gap-3 py-2 text-xs">
                <kbd className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300">
                  {shortcut.keys}
                </kbd>
                <span className="min-w-0 flex-1 text-zinc-300">{shortcut.description}</span>
                <span className="text-[10px] text-zinc-600">{shortcut.scope}</span>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MachineExplorer(props: {
  machines: Machine[];
  metricsActive: boolean;
  pending: boolean;
  error: boolean;
  confirmNavigation: (destination?: string) => boolean;
  onNavigate: () => void;
  replaceNavigation: boolean;
}) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const navigate = (destination: string) => {
    if (!props.confirmNavigation(destination)) return;
    props.onNavigate();
    if (props.replaceNavigation) router.replace(destination);
    else router.push(destination);
  };

  return (
    <section
      aria-label="计算资源"
      className="cm-resource-explorer m-2 flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="cm-resource-explorer-header relative flex h-10 shrink-0 items-center border-b border-zinc-800">
        <button
          type="button"
          className={`cm-sidebar-nav-flat flex h-full min-w-0 flex-1 items-center gap-2 border-0 bg-transparent pr-10 pl-3 text-start text-[11px] font-medium tracking-wide uppercase hover:text-zinc-200 ${
            pathname === "/machines" ? "text-zinc-200" : "text-zinc-400"
          }`}
          title="查看全部电脑"
          onClick={() => navigate("/machines")}
          onPointerEnter={() => router.prefetch("/machines")}
          onFocus={() => router.prefetch("/machines")}
        >
          <ComputeResourcesIcon className="shrink-0 text-zinc-500" />
          <span>计算资源</span>
          <span className="rounded-full border border-zinc-700 bg-zinc-950/60 px-1.5 py-0.5 text-[9px] leading-none font-normal tabular-nums text-zinc-500">
            {props.machines.length}
          </span>
        </button>
        <button
          type="button"
          className="cm-icon-button absolute top-1/2 right-2 z-10 -translate-y-1/2"
          title="新建电脑"
          aria-label="新建电脑"
          onClick={() => navigate("/machines/new")}
          onPointerEnter={() => router.prefetch("/machines/new")}
          onFocus={() => router.prefetch("/machines/new")}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {props.pending ? null : props.error ? (
          <p className="px-3 py-2 text-xs text-red-400">电脑列表加载失败</p>
        ) : props.machines.length === 0 ? (
          <p className="px-3 py-3 text-xs leading-5 text-zinc-500">还没有电脑，点击右上角 + 创建</p>
        ) : (
          props.machines.map((machine) => (
            <MachineTreeItem
              key={machine.id}
              machine={machine}
              metricsActive={props.metricsActive}
              pathname={pathname}
              confirmNavigation={props.confirmNavigation}
              onNavigate={props.onNavigate}
              replaceNavigation={props.replaceNavigation}
            />
          ))
        )}
      </div>
    </section>
  );
}

function MachineTreeItem(props: {
  machine: Machine;
  metricsActive: boolean;
  pathname: string;
  confirmNavigation: (destination?: string) => boolean;
  onNavigate: () => void;
  replaceNavigation: boolean;
}) {
  const { machine } = props;
  const region = regionLabel(machine.region);
  const destination = machine.readyAt
    ? `/machines/${machine.id}`
    : `/machines/${machine.id}/provisioning`;
  const router = useRouter();
  const queryClient = useQueryClient();
  const runtime = useWorkbenchRuntime();
  const [expanded, setExpanded] = useState(() =>
    props.pathname.startsWith(`/machines/${machine.id}`),
  );
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState(DEFAULT_WORKSPACE_DISPLAY_NAME);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceCreateMode, setWorkspaceCreateMode] = useState<"directory" | "git">("directory");
  const [gitRepositoryUrl, setGitRepositoryUrl] = useState("");
  const [gitWorkspaceName, setGitWorkspaceName] = useState("");
  const [gitWorkspacePath, setGitWorkspacePath] = useState("");
  const [gitNameEdited, setGitNameEdited] = useState(false);
  const [gitPathEdited, setGitPathEdited] = useState(false);
  const [gitPrivate, setGitPrivate] = useState(false);
  const [gitSaveCredentials, setGitSaveCredentials] = useState(true);
  const [gitUsername, setGitUsername] = useState("");
  const [gitToken, setGitToken] = useState("");
  const [gitImport, setGitImport] = useState<WorkspaceGitImportStatus | null>(null);
  const gitImportLogRef = useRef<HTMLPreElement>(null);
  const gitImportLogFollowing = useRef(true);
  const gitImportCursor = useRef(0);
  const gitIdempotencyKey = useRef(crypto.randomUUID());
  const [renamingMachine, setRenamingMachine] = useState(false);
  const [renameMachineError, setRenameMachineError] = useState<string | null>(null);
  const [renamingWorkspace, setRenamingWorkspace] = useState<Workspace | null>(null);
  const [renameWorkspaceError, setRenameWorkspaceError] = useState<string | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<Workspace | null>(null);
  const workspacesQuery = useQuery({
    queryKey: ["workspaces", machine.id],
    queryFn: () => api.workspaces.list(machine.id),
    enabled: expanded && machine.readyAt !== null,
  });
  useEffect(() => {
    queryClient.setQueryData<Machine>(["machine", machine.id], (current) =>
      mergeMachineDetailSnapshot(current, machine),
    );
    const workspaces = workspacesQuery.data;
    if (!workspaces) return;
    for (const workspace of workspaces)
      queryClient.setQueryData(["workspace", workspace.id], workspace);
    const saveData = (navigator as Navigator & { connection?: { readonly saveData?: boolean } })
      .connection?.saveData;
    if (!expanded || saveData || document.visibilityState === "hidden") return;

    const recentOrder = new Map<string, number>();
    for (const [index, entry] of (runtime?.recent ?? []).entries()) {
      const url = new URL(entry.href, window.location.origin);
      const location = workspaceLocation(url.pathname, url.search.slice(1));
      if (location?.machineId === machine.id) recentOrder.set(location.workspaceId, index);
    }
    const candidates = [...workspaces]
      .sort(
        (left, right) =>
          (recentOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (recentOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      )
      .slice(0, 8);
    let cancelled = false;
    const prefetch = async () => {
      const queue = [...candidates];
      const worker = async () => {
        while (!cancelled && document.visibilityState !== "hidden") {
          const workspace = queue.shift();
          if (!workspace) return;
          await queryClient
            .prefetchQuery({
              queryKey: ["workbench-layout", workspace.id],
              queryFn: () => api.workbench.getLayout(workspace.id),
              staleTime: 30_000,
              retry: false,
            })
            .catch(() => undefined);
        }
      };
      await Promise.all([worker(), worker()]);
    };
    const start = () => void prefetch();
    if ("requestIdleCallback" in window) {
      const handle = window.requestIdleCallback(start, { timeout: 2_000 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(handle);
      };
    }
    const handle = globalThis.setTimeout(start, 300);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(handle);
    };
  }, [expanded, machine, queryClient, runtime?.recent, workspacesQuery.data]);
  const workspaceRoot = workspaceRootForRegistrations(workspacesQuery.data ?? []);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["workspaces", machine.id] });
  const createWorkspace = useMutation({
    mutationFn: (input: { name: string; path: string; mode: "create" | "register" }) =>
      api.workspaces.create(machine.id, input),
    onSuccess: (workspace) => {
      setWorkspaceDialogOpen(false);
      setWorkspaceError(null);
      void invalidate();
      setExpanded(true);
      if (props.confirmNavigation()) {
        props.onNavigate();
        const destination = `/machines/${machine.id}/workspaces/${workspace.id}`;
        if (props.replaceNavigation) router.replace(destination);
        else router.push(destination);
      }
    },
    onError: (error) => setWorkspaceError(userErrorMessage(error, "创建项目失败，请稍后重试")),
  });
  const createGitWorkspace = useMutation({
    mutationFn: (input: {
      name: string;
      path: string;
      repositoryUrl: string;
      credentials?: { username: string; token: string };
      saveCredentials?: boolean;
    }) => api.workspaces.createFromGit(machine.id, input, gitIdempotencyKey.current),
    onSuccess: (started) => {
      gitImportCursor.current = 0;
      setGitToken("");
      setGitImport({
        ...started,
        // Replay may already be terminal; force one status read to settle the dialog.
        state: "queued",
        stage: "queued",
        output: [],
        nextCursor: 0,
        error: null,
        workspace: {
          id: started.workspaceId,
          machineId: machine.id,
          name: gitWorkspaceName.trim(),
          path: gitWorkspacePath.trim(),
          lifecycleStatus: "creating",
          deleteFilesRequested: false,
          deleteFilesDowngradeAllowed: false,
          lastError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      void invalidate();
    },
    onError: (error) => {
      setGitToken("");
      setWorkspaceError(userErrorMessage(error, "Git 拉取任务提交失败"));
    },
  });
  const cancelGitWorkspace = useMutation({
    mutationFn: (operationId: string) => api.workspaces.cancelGitImport(operationId),
    onError: (error) => setWorkspaceError(userErrorMessage(error, "取消 Git 拉取失败")),
  });
  const gitImportOperationId = gitImport?.operationId;
  const gitImportState = gitImport?.state;
  const confirmNavigation = props.confirmNavigation;
  const onNavigate = props.onNavigate;
  const replaceNavigation = props.replaceNavigation;
  useEffect(() => {
    gitImportLogFollowing.current = true;
    const log = gitImportLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [gitImport?.operationId]);
  useEffect(() => {
    if (!gitImportLogFollowing.current) return;
    const log = gitImportLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [gitImport?.nextCursor, gitImport?.stage]);
  useEffect(() => {
    const operationId = gitImportOperationId;
    if (
      !workspaceDialogOpen ||
      !operationId ||
      !gitImportState ||
      ["completed", "failed", "cancelled"].includes(gitImportState)
    ) {
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const status = await api.workspaces.gitImportStatus(operationId, gitImportCursor.current);
        if (disposed) return;
        const output = [...status.output];
        let nextCursor = status.nextCursor;
        if (["completed", "failed", "cancelled"].includes(status.state)) {
          // A terminal import can have more than one page of output; drain before polling stops.
          let pageLength = status.output.length;
          while (pageLength === 100) {
            const page = await api.workspaces.gitImportStatus(operationId, nextCursor);
            if (disposed) return;
            if (page.nextCursor <= nextCursor) break;
            output.push(...page.output);
            nextCursor = page.nextCursor;
            pageLength = page.output.length;
          }
        }
        gitImportCursor.current = nextCursor;
        setGitImport((current) =>
          current?.operationId === operationId
            ? { ...status, nextCursor, output: [...current.output, ...output].slice(-256) }
            : current,
        );
        setWorkspaceError(status.error?.message ?? null);
        if (status.state === "completed") {
          setGitToken("");
          setWorkspaceDialogOpen(false);
          void queryClient.invalidateQueries({ queryKey: ["workspaces", machine.id] });
          setExpanded(true);
          if (confirmNavigation()) {
            onNavigate();
            const target = `/machines/${machine.id}/workspaces/${status.workspace.id}`;
            if (replaceNavigation) router.replace(target);
            else router.push(target);
          }
          toastSuccess("已从 Git 创建项目");
          return;
        }
        if (status.state === "failed" || status.state === "cancelled") return;
      } catch (error) {
        if (!disposed) setWorkspaceError(userErrorMessage(error, "读取 Git 拉取进度失败"));
      }
      if (!disposed) timer = setTimeout(() => void poll(), 500);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    confirmNavigation,
    gitImportOperationId,
    gitImportState,
    machine.id,
    onNavigate,
    queryClient,
    replaceNavigation,
    router,
    workspaceDialogOpen,
  ]);
  const updateMachine = useMutation({
    mutationFn: (name: string) => api.machines.update(machine.id, { name }),
    onSuccess: (updated) => {
      queryClient.setQueryData<Machine[]>(["machines"], (current) =>
        current?.map((item) => (item.id === updated.id ? updated : item)),
      );
      queryClient.setQueryData<Machine>(["machine", updated.id], updated);
      setRenamingMachine(false);
      setRenameMachineError(null);
      toastSuccess("电脑已重命名");
    },
    onError: (error) => setRenameMachineError(userErrorMessage(error, "重命名电脑失败")),
  });
  const updateWorkspace = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.workspaces.update(id, { name }),
    onSuccess: (updated) => {
      queryClient.setQueryData<Workspace[]>(["workspaces", machine.id], (current) =>
        current?.map((workspace) => (workspace.id === updated.id ? updated : workspace)),
      );
      queryClient.setQueryData<Workspace>(["workspace", updated.id], updated);
      setRenamingWorkspace(null);
      setRenameWorkspaceError(null);
      void invalidate();
      toastSuccess("项目已重命名");
    },
    onError: (error) => setRenameWorkspaceError(userErrorMessage(error, "更新项目失败")),
  });
  const deleteWorkspace = useMutation({
    mutationFn: (input: { id: string; deleteFiles: boolean }) =>
      api.workspaces.delete(input.id, { deleteFiles: input.deleteFiles }),
    onSuccess: (_, input) => {
      setDeletingWorkspace(null);
      queryClient.setQueryData<Workspace[]>(["workspaces", machine.id], (workspaces) =>
        workspaces?.filter((workspace) => workspace.id !== input.id),
      );
      void invalidate();
      for (const queryKey of [
        "workspace",
        "workspace-status",
        "workbench-layout",
        "workspace-diff",
      ]) {
        queryClient.removeQueries({ queryKey: [queryKey, input.id] });
      }
      runtime?.evict(`${machine.id}:${input.id}`);
      toastSuccess(
        input.deleteFiles ? "已彻底删除项目及其磁盘文件" : "已移除项目登记，磁盘文件保留",
      );

      if (isWorkspaceRoute(props.pathname, machine.id, input.id)) {
        props.onNavigate();
        router.replace(`/machines/${machine.id}`);
      }
    },
    onError: (error) => {
      void invalidate();
      toastError(userErrorMessage(error, "删除项目失败"));
    },
  });
  const currentDeletingWorkspace = deletingWorkspace
    ? (workspacesQuery.data?.find((workspace) => workspace.id === deletingWorkspace.id) ??
      deletingWorkspace)
    : null;
  const gitImportActive =
    gitImport !== null && (gitImport.state === "queued" || gitImport.state === "running");
  const workspaceDialogBusy =
    createWorkspace.isPending || createGitWorkspace.isPending || gitImportActive;
  return (
    <div>
      <div
        className={`cm-touch-target group grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-start rounded-[8px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 ${
          props.pathname === `/machines/${machine.id}`
            ? "bg-[var(--cm-accent-muted)] text-zinc-100"
            : ""
        }`}
      >
        <button
          type="button"
          className="cm-touch-square relative z-10 col-start-1 row-start-1 flex h-9 w-6 shrink-0 items-center justify-center text-zinc-600 hover:text-zinc-300"
          onClick={() => setExpanded((value) => !value)}
          aria-label={expanded ? "收起电脑" : "展开电脑"}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!props.confirmNavigation(destination)) return;
            setExpanded(true);
            props.onNavigate();
            if (props.replaceNavigation) router.replace(destination);
            else router.push(destination);
          }}
          onPointerEnter={() => router.prefetch(destination)}
          onFocus={() => router.prefetch(destination)}
          aria-label={machine.name}
          title={region ? `${machine.name} · ${region}` : machine.name}
          className="cm-sidebar-nav-flat col-span-4 col-start-1 row-span-2 row-start-1 grid min-w-0 grid-cols-subgrid grid-rows-subgrid border-0 bg-transparent text-start"
        >
          <span className="col-start-2 row-start-1 flex min-w-0 items-start gap-2 py-1.5 pr-1">
            <Laptop size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-xs">{machine.name}</span>
                <StatusDot status={machine.lifecycleStatus} />
              </span>
            </span>
          </span>
          <div className="col-span-4 row-start-2 pb-1.5 pr-2 pl-[46px]">
            <SidebarMachineMetrics machine={machine} active={props.metricsActive} />
          </div>
        </button>
        <button
          type="button"
          className="cm-icon-button relative z-10 col-start-3 row-start-1 mt-1 opacity-100 lg:[@media(hover:hover)]:opacity-0 lg:[@media(hover:hover)]:group-hover:opacity-100"
          title="重命名电脑"
          aria-label={`重命名电脑“${machine.name}”`}
          disabled={updateMachine.isPending}
          onClick={() => {
            setRenameMachineError(null);
            setRenamingMachine(true);
          }}
        >
          <Pencil size={12} />
        </button>
        <button
          type="button"
          className="cm-icon-button relative z-10 col-start-4 row-start-1 mt-1 opacity-100 lg:[@media(hover:hover)]:opacity-0 lg:[@media(hover:hover)]:group-hover:opacity-100"
          title="新建项目"
          disabled={machine.readyAt === null || openingWorkspace}
          onClick={async () => {
            setOpeningWorkspace(true);
            setWorkspaceName(DEFAULT_WORKSPACE_DISPLAY_NAME);
            setWorkspaceError(null);
            setWorkspaceCreateMode("directory");
            setGitRepositoryUrl("");
            setGitWorkspaceName("");
            setGitNameEdited(false);
            setGitPathEdited(false);
            setGitPrivate(false);
            setGitSaveCredentials(true);
            setGitUsername("");
            setGitToken("");
            setGitImport(null);
            gitImportCursor.current = 0;
            gitIdempotencyKey.current = crypto.randomUUID();
            try {
              const registered = await queryClient.fetchQuery({
                queryKey: ["workspaces", machine.id],
                queryFn: () => api.workspaces.list(machine.id),
              });
              const activeImport = await api.workspaces
                .activeGitImport(machine.id)
                .catch(() => null);
              const root = workspaceRootForRegistrations(registered);
              setWorkspacePath(`${root}/${DEFAULT_NEW_PROJECT_DIRECTORY}`);
              setGitWorkspacePath(`${root}/project`);
              if (activeImport) {
                setWorkspaceCreateMode("git");
                gitImportCursor.current = activeImport.nextCursor;
                setGitImport(activeImport);
              }
            } catch {
              setWorkspacePath(`${workspaceRoot}/${DEFAULT_NEW_PROJECT_DIRECTORY}`);
              setGitWorkspacePath(`${workspaceRoot}/project`);
              setWorkspaceError("读取项目列表失败，已使用标准目录，请确认后再创建");
            } finally {
              setOpeningWorkspace(false);
              setWorkspaceDialogOpen(true);
            }
          }}
        >
          <FolderPlus size={12} />
        </button>
      </div>
      {expanded && (
        <div className="ml-5 pl-1">
          {machine.readyAt === null ? (
            <button
              type="button"
              onClick={() => {
                if (!props.confirmNavigation(destination)) return;
                props.onNavigate();
                if (props.replaceNavigation) router.replace(destination);
                else router.push(destination);
              }}
              onPointerEnter={() => router.prefetch(destination)}
              onFocus={() => router.prefetch(destination)}
              className="cm-sidebar-nav-flat block w-full border-0 bg-transparent px-2 py-1 text-start text-[10px] text-amber-400 hover:text-amber-300"
            >
              正在准备电脑…
            </button>
          ) : workspacesQuery.isPending ? null : workspacesQuery.data?.length ? (
            workspacesQuery.data.map((workspace) => (
              <WorkspaceTreeItem
                key={workspace.id}
                workspace={workspace}
                machine={machine}
                pathname={props.pathname}
                confirmNavigation={props.confirmNavigation}
                onNavigate={props.onNavigate}
                replaceNavigation={props.replaceNavigation}
                workspaceUpdatePending={updateWorkspace.isPending}
                workspaceDeletePending={deleteWorkspace.isPending}
                onRenameWorkspace={() => {
                  setRenamingWorkspace(workspace);
                  setRenameWorkspaceError(null);
                }}
                onDeleteWorkspace={() => {
                  if (
                    isWorkspaceRoute(props.pathname, machine.id, workspace.id) &&
                    !props.confirmNavigation()
                  )
                    return;
                  setDeletingWorkspace(workspace);
                }}
              />
            ))
          ) : (
            <p className="px-2 py-1 text-[10px] text-zinc-600">暂无项目</p>
          )}
        </div>
      )}
      <Dialog
        open={workspaceDialogOpen}
        onOpenChange={(open) => {
          if (!workspaceDialogBusy) {
            if (!open) setGitToken("");
            setWorkspaceDialogOpen(open);
          }
        }}
      >
        <DialogContent
          className="cm-new-project-dialog max-w-lg border-zinc-800 bg-zinc-900 text-zinc-100"
          showCloseButton={!workspaceDialogBusy}
        >
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (gitImport) return;
              const gitMode = workspaceCreateMode === "git";
              const name = (gitMode ? gitWorkspaceName : workspaceName).trim();
              const path = (gitMode ? gitWorkspacePath : workspacePath).trim();
              if (!name) {
                setWorkspaceError("请输入项目名称");
                return;
              }
              if (!path.startsWith("/")) {
                setWorkspaceError(
                  `项目目录必须是绝对路径，例如 ${workspaceRoot}/${DEFAULT_NEW_PROJECT_DIRECTORY}`,
                );
                return;
              }
              if (gitMode && !gitRepositoryUrl.trim()) {
                setWorkspaceError("请输入 Git 仓库地址");
                return;
              }
              if (gitMode && gitPrivate && (!gitUsername.trim() || !gitToken)) {
                setWorkspaceError("请输入私有仓库的用户名和访问令牌");
                return;
              }
              setWorkspaceError(null);
              if (gitMode) {
                createGitWorkspace.mutate({
                  name,
                  path,
                  repositoryUrl: gitRepositoryUrl.trim(),
                  ...(gitPrivate
                    ? {
                        credentials: { username: gitUsername.trim(), token: gitToken },
                        saveCredentials: gitSaveCredentials,
                      }
                    : {}),
                });
              } else {
                createWorkspace.mutate({ name, path, mode: "create" });
              }
            }}
          >
            <DialogHeader className="shrink-0 pr-8">
              <DialogTitle>新建项目</DialogTitle>
              <DialogDescription className="text-zinc-400">
                在电脑“{machine.name}”中创建项目
              </DialogDescription>
            </DialogHeader>
            {!gitImport && (
              <div
                role="group"
                aria-label="创建项目方式"
                className="cm-new-project-tabs mt-3 grid w-full shrink-0 grid-cols-2 p-0.5"
              >
                {(["directory", "git"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={workspaceCreateMode === mode}
                    className="cm-new-project-tab inline-flex items-center justify-center"
                    onClick={() => {
                      setWorkspaceCreateMode(mode);
                      setWorkspaceError(null);
                    }}
                  >
                    {mode === "directory" ? "新建目录" : "从 Git 创建"}
                  </button>
                ))}
              </div>
            )}
            <div className="cm-new-project-fields mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              {gitImport ? (
                <div className="flex h-full min-h-0 flex-col gap-3">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-zinc-300">
                      {GIT_IMPORT_STAGE_LABELS[gitImport.stage]}
                    </span>
                    {gitImportActive && (
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                    )}
                  </div>
                  <pre
                    ref={gitImportLogRef}
                    className="min-h-0 flex-1 overflow-auto rounded-md bg-zinc-950 p-3 text-[10px] leading-4 whitespace-pre-wrap text-zinc-400"
                    onScroll={(event) => {
                      const log = event.currentTarget;
                      gitImportLogFollowing.current =
                        log.scrollHeight - log.scrollTop - log.clientHeight <= 16;
                    }}
                  >
                    {gitImport.output.length > 0
                      ? gitImport.output.join("")
                      : gitImportActive
                        ? "正在准备拉取代码…"
                        : "没有可显示的拉取日志"}
                  </pre>
                </div>
              ) : workspaceCreateMode === "directory" ? (
                <>
                  <label className="block">
                    <span className="mb-1.5 block text-[11px] font-medium text-zinc-500">
                      项目名称
                    </span>
                    <input
                      required
                      maxLength={100}
                      value={workspaceName}
                      onChange={(event) => setWorkspaceName(event.target.value)}
                      className="cm-input cm-new-project-input"
                      placeholder={DEFAULT_WORKSPACE_DISPLAY_NAME}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[11px] font-medium text-zinc-500">
                      项目目录
                    </span>
                    <input
                      required
                      value={workspacePath}
                      onChange={(event) => setWorkspacePath(event.target.value)}
                      className="cm-input cm-new-project-input font-mono"
                      placeholder={`${workspaceRoot}/${DEFAULT_NEW_PROJECT_DIRECTORY}`}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="block">
                    <span className="mb-1.5 block text-[11px] font-medium text-zinc-500">
                      Git 仓库地址
                    </span>
                    <input
                      required
                      type="url"
                      value={gitRepositoryUrl}
                      onChange={(event) => {
                        const value = event.target.value;
                        setGitRepositoryUrl(value);
                        const derived = gitRepositoryName(value);
                        if (!derived) return;
                        if (!gitNameEdited) setGitWorkspaceName(derived);
                        if (!gitPathEdited) setGitWorkspacePath(`${workspaceRoot}/${derived}`);
                      }}
                      className="cm-input cm-new-project-input font-mono"
                      placeholder="https://git.example.com/team/project.git"
                    />
                  </label>
                  <div className="space-y-3">
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-medium text-zinc-500">
                        项目名称
                      </span>
                      <input
                        required
                        maxLength={100}
                        value={gitWorkspaceName}
                        onChange={(event) => {
                          setGitNameEdited(true);
                          setGitWorkspaceName(event.target.value);
                        }}
                        className="cm-input cm-new-project-input"
                        placeholder="project"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-medium text-zinc-500">
                        项目目录
                      </span>
                      <input
                        required
                        value={gitWorkspacePath}
                        onChange={(event) => {
                          setGitPathEdited(true);
                          setGitWorkspacePath(event.target.value);
                        }}
                        className="cm-input cm-new-project-input font-mono"
                        placeholder={`${workspaceRoot}/project`}
                      />
                    </label>
                  </div>
                  <label className="cm-new-project-private-toggle flex items-center gap-2 text-zinc-400">
                    <input
                      type="checkbox"
                      checked={gitPrivate}
                      onChange={(event) => {
                        setGitPrivate(event.target.checked);
                        if (!event.target.checked) {
                          setGitUsername("");
                          setGitToken("");
                        }
                      }}
                      className="h-3.5 w-3.5"
                    />
                    私有仓库
                  </label>
                  {gitPrivate && (
                    <div className="space-y-3">
                      <label className="block">
                        <span className="mb-1.5 block text-[11px] font-medium text-zinc-500">
                          用户名
                        </span>
                        <input
                          required
                          autoComplete="username"
                          value={gitUsername}
                          onChange={(event) => setGitUsername(event.target.value)}
                          className="cm-input cm-new-project-input"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-[11px] font-medium text-zinc-500">
                          访问令牌 / 密码
                        </span>
                        <input
                          required
                          type="password"
                          autoComplete="off"
                          value={gitToken}
                          onChange={(event) => setGitToken(event.target.value)}
                          className="cm-input cm-new-project-input"
                        />
                      </label>
                      <label className="cm-new-project-private-toggle flex items-start gap-2 text-zinc-400">
                        <input
                          type="checkbox"
                          checked={gitSaveCredentials}
                          onChange={(event) => setGitSaveCredentials(event.target.checked)}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0"
                        />
                        <span>保存凭证，供此项目后续拉取和推送使用</span>
                      </label>
                      <p className="text-[10px] leading-4 text-zinc-600">
                        {gitSaveCredentials
                          ? "Git凭证保存在 ~/.git-credentials 目录下。"
                          : "凭据仅用于本次拉取，不会保存到项目或电脑中。"}
                      </p>
                    </div>
                  )}
                </>
              )}
              {workspaceError && (
                <p className="rounded border px-3 py-2 text-xs cm-banner-danger">
                  {workspaceError}
                </p>
              )}
            </div>
            <DialogFooter className="mt-4 shrink-0 border-zinc-800 bg-zinc-950/40">
              {gitImport ? (
                gitImportActive ? (
                  <button
                    type="button"
                    className="cm-button"
                    disabled={cancelGitWorkspace.isPending}
                    onClick={() => cancelGitWorkspace.mutate(gitImport.operationId)}
                  >
                    {cancelGitWorkspace.isPending ? "正在取消…" : "取消拉取"}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="cm-button"
                      onClick={() => {
                        setGitToken("");
                        setWorkspaceDialogOpen(false);
                      }}
                    >
                      关闭
                    </button>
                    <button
                      type="button"
                      className="cm-button-primary"
                      onClick={() => {
                        gitIdempotencyKey.current = crypto.randomUUID();
                        setGitImport(null);
                        setWorkspaceError(null);
                      }}
                    >
                      重试
                    </button>
                  </>
                )
              ) : (
                <>
                  <button
                    type="button"
                    className="cm-button"
                    disabled={createWorkspace.isPending || createGitWorkspace.isPending}
                    onClick={() => {
                      setGitToken("");
                      setWorkspaceDialogOpen(false);
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="cm-button-primary"
                    disabled={createWorkspace.isPending || createGitWorkspace.isPending}
                  >
                    {createWorkspace.isPending || createGitWorkspace.isPending
                      ? "正在创建…"
                      : workspaceCreateMode === "git"
                        ? "拉取并创建"
                        : "创建项目"}
                  </button>
                </>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {renamingWorkspace && (
        <RenameDialog
          key={renamingWorkspace.id}
          open
          initialName={renamingWorkspace.name}
          busy={updateWorkspace.isPending}
          error={renameWorkspaceError}
          title="重命名项目"
          description="只修改显示名称，不会移动或重命名磁盘目录"
          fieldLabel="项目名称"
          emptyError="请输入项目名称"
          onOpenChange={(open) => {
            if (!open) {
              setRenamingWorkspace(null);
              setRenameWorkspaceError(null);
            }
          }}
          onSubmit={(name) => updateWorkspace.mutate({ id: renamingWorkspace.id, name })}
        />
      )}
      {currentDeletingWorkspace && (
        <WorkspaceDeleteDialog
          key={`${currentDeletingWorkspace.id}:${currentDeletingWorkspace.deleteFilesRequested}:${currentDeletingWorkspace.deleteFilesDowngradeAllowed}`}
          workspace={currentDeletingWorkspace}
          hasUnsavedFiles={
            (runtime?.resources[`${machine.id}:${currentDeletingWorkspace.id}`]?.dirty ?? 0) > 0
          }
          busy={deleteWorkspace.isPending}
          onCancel={() => setDeletingWorkspace(null)}
          onConfirm={(deleteFiles) => {
            const target = currentDeletingWorkspace;
            deleteWorkspace.mutate({ id: target.id, deleteFiles });
          }}
        />
      )}
      {renamingMachine && (
        <RenameDialog
          key={machine.name}
          open
          initialName={machine.name}
          busy={updateMachine.isPending}
          error={renameMachineError}
          title="重命名电脑"
          description="只修改显示名称，不会修改云端实例标识或影响电脑资源"
          fieldLabel="电脑名称"
          emptyError="请输入电脑名称"
          onOpenChange={(open) => {
            setRenamingMachine(open);
            if (!open) setRenameMachineError(null);
          }}
          onSubmit={(name) => updateMachine.mutate(name)}
        />
      )}
    </div>
  );
}

function WorkspaceTreeItem(props: {
  workspace: Workspace;
  machine: Machine;
  pathname: string;
  confirmNavigation: (destination?: string) => boolean;
  onNavigate: () => void;
  replaceNavigation: boolean;
  workspaceUpdatePending: boolean;
  workspaceDeletePending: boolean;
  onRenameWorkspace: () => void;
  onDeleteWorkspace: () => void;
}) {
  const { workspace, machine } = props;
  const runtime = useWorkbenchRuntime();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { platformKind } = useClientHost();
  const workspacePath = `/machines/${machine.id}/workspaces/${workspace.id}`;
  const selected = isWorkspaceRoute(props.pathname, machine.id, workspace.id);
  return (
    <div
      className={`group flex items-center rounded-[8px] transition-colors ${
        selected ? "bg-[var(--cm-accent-muted)]" : "hover:bg-zinc-800/70"
      }`}
    >
      <button
        type="button"
        data-prefetch-href={workspacePath}
        onClick={() => {
          if (!props.confirmNavigation(workspacePath)) return;
          queryClient.setQueryData<Machine>(["machine", machine.id], (current) =>
            mergeMachineDetailSnapshot(current, machine),
          );
          queryClient.setQueryData(["workspace", workspace.id], workspace);
          beginWorkspaceNavigation(`${machine.id}:${workspace.id}`, {
            client: platformKind,
            temperature: runtime?.entries.some(
              (entry) => entry.key === `${machine.id}:${workspace.id}`,
            )
              ? "warm"
              : "cold",
          });
          props.onNavigate();
          if (runtime?.navigateCached(workspacePath, props.replaceNavigation)) return;
          if (props.replaceNavigation) router.replace(workspacePath);
          else router.push(workspacePath);
        }}
        aria-current={selected ? "page" : undefined}
        className={`cm-sidebar-nav-flat flex min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent px-2 py-1.5 text-start text-xs ${selected ? "text-zinc-300" : "text-zinc-500"}`}
      >
        <Folder size={12} />
        <span className="truncate">{workspace.name}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`管理项目“${workspace.name}”`}
          className="cm-icon-button mr-0.5"
        >
          <MoreHorizontal size={11} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4} className="w-52">
          <DropdownMenuItem
            disabled={props.workspaceUpdatePending || workspace.lifecycleStatus === "deleting"}
            onClick={props.onRenameWorkspace}
          >
            <Pencil size={12} /> 重命名
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={props.workspaceDeletePending}
            onClick={props.onDeleteWorkspace}
          >
            <Trash2 size={12} />
            {workspace.lifecycleStatus === "deleting" ? "重试删除" : "删除"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function StatusDot({ status }: { status: Machine["lifecycleStatus"] }) {
  const color =
    status === "running"
      ? "bg-emerald-400"
      : status === "error"
        ? "bg-red-500"
        : [
              "provisioning",
              "starting",
              "stopping",
              "snapshotting",
              "restoring",
              "rebuilding",
            ].includes(status)
          ? "animate-pulse bg-amber-400"
          : "bg-zinc-600";
  return <LifecycleIndicator status={status} dotClassName={color} />;
}

function StatusBar({ machine }: { machine: Machine | null }) {
  const runtime = useWorkbenchRuntime();
  const statusKey = runtime?.current ? `workspace:${runtime.current.workspaceId}` : null;
  const activeFilePath = useWorkbenchStore((state) =>
    runtime
      ? statusKey
        ? (state.editorStatuses[statusKey]?.activeFilePath ?? null)
        : null
      : state.activeFilePath,
  );
  const openFileCount = useWorkbenchStore((state) =>
    runtime
      ? statusKey
        ? (state.editorStatuses[statusKey]?.openFileCount ?? 0)
        : 0
      : state.openFileCount,
  );
  const dirtyFileCount = useWorkbenchStore((state) =>
    runtime
      ? statusKey
        ? (state.editorStatuses[statusKey]?.dirtyFileCount ?? 0)
        : 0
      : state.dirtyFileCount,
  );
  const terminalCount = useWorkbenchStore((state) =>
    runtime ? (statusKey ? (state.terminalCounts[statusKey] ?? 0) : 0) : state.terminalCount,
  );
  const region = machine ? regionLabel(machine.region) : undefined;
  return (
    <footer
      className="cm-statusbar flex items-center gap-3 border-t border-zinc-800 px-2 text-[10px] text-zinc-500"
      style={{ background: "var(--cm-surface-titlebar)" }}
    >
      <span className="flex items-center gap-1 text-zinc-400">
        <Cloud size={11} />
        云编程环境
      </span>
      {machine ? (
        <>
          <span className="flex items-center gap-1">
            <StatusDot status={machine.lifecycleStatus} />
            {lifecycleLabel(machine.lifecycleStatus)}
          </span>
          {region ? <span className="hidden sm:inline">{region}</span> : null}
          {openFileCount > 0 && (
            <span
              className="hidden min-w-0 items-center gap-1 md:flex"
              title={activeFilePath ?? ""}
            >
              <FileCode2 size={10} />
              <span className="max-w-40 truncate">
                {activeFilePath?.split("/").at(-1) ?? "文件"}
              </span>
              <span className="text-zinc-600">({openFileCount})</span>
              {dirtyFileCount > 0 && (
                <span className="text-amber-400">● {dirtyFileCount} 未保存</span>
              )}
            </span>
          )}
          {terminalCount > 0 && (
            <span className="hidden items-center gap-1 sm:flex">
              <TerminalSquare size={10} /> {terminalCount} 个终端
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            <span
              className={`h-1.5 w-1.5 rounded-full ${machine.agentConnectionState === "connected" ? "bg-emerald-400" : "bg-zinc-600"}`}
            />
            {machine.agentConnectionState === "connected" ? "通信正常" : "通信中断"}
          </span>
        </>
      ) : (
        <span className="ml-auto flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          就绪
        </span>
      )}
    </footer>
  );
}
