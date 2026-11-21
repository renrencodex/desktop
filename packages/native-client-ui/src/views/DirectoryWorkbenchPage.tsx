"use client";

import {
  isApiError,
  type WorkbenchLayout,
  type WorkbenchLayoutState,
  type WorkbenchTab,
} from "@cloud-machine/api-client";
import { isMachineRuntimeAvailable } from "@cloud-machine/client-contracts";
import { hasCapability } from "@cloud-machine/platform-api";
import {
  CLIENT_PERFORMANCE_MEASURES,
  ensureWorkspaceNavigation,
  recordWorkspaceNavigation,
  updateWorkbenchApplicationPane,
} from "@cloud-machine/workspace-ui";
import { ApplicationsWorkbench } from "../components/ApplicationsWorkbench";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileDiff, FolderTree, Globe2, LayoutGrid, Plus, TerminalSquare, X } from "lucide-react";
import { useClientHost, usePathname, useRouter, useSearchParams } from "../host";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { FileBufferStatus } from "../components/FilesPanel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { focusTabAt, tablistArrowTarget } from "../lib/tablist-navigation";
import { api } from "../lib/api";
import { createLatestSaveQueue } from "../lib/latest-save-queue";
import { rebaseWorkbenchLayout, workbenchLayoutsEqual } from "../lib/workbench-layout-sync";
import { isNotFoundError, userErrorMessage } from "../lib/user-error";
import { useResponsiveViewport, useVirtualKeyboardOpen } from "../lib/responsive";
import {
  activateApplicationsTab,
  activatePreferredWorkspaceTab,
  activateTerminalPane,
  activateTab,
  addBrowserTab,
  addDiffTab,
  addExplorerTab,
  addTerminalTab,
  closeWorkbenchTab,
  closeTerminalPane,
  EMPTY_WORKBENCH_LAYOUT,
  MAX_TERMINAL_TABS,
  MAX_WORKBENCH_TABS,
  openFileInExplorer,
  remapExplorerFiles,
  removeExplorerFiles,
  reorderWorkbenchTab,
  resizeTerminalSplit,
  splitTerminalPane,
  terminalPaneIds,
  updateBrowserUrl,
  updateExplorerTreeLayout,
  updateTerminalTitle,
  workbenchTabLabel,
} from "../lib/workbench-tabs";
import { destroyTerminalSession } from "../lib/terminal-channel";
import { workspaceRecoveryTarget } from "../lib/workspace-navigation";
import {
  workspaceMachinePollInterval,
  workspaceStatusPollInterval,
} from "../lib/workspace-runtime-recovery";
import { useWorkbenchStore } from "../stores/workbench";
import { useWorkbenchRuntime } from "../components/workbench-runtime-context";
import { useAuthStore } from "../stores/auth";
import type { WorkspaceLocation } from "../lib/workspace-cache";

type LayoutSyncState = "idle" | "saving" | "saved" | "error";
type LayoutSaveRequest = { base: WorkbenchLayoutState; layout: WorkbenchLayout };

function layoutRefreshBlocked(state: LayoutSyncState): boolean {
  return state === "saving" || state === "error";
}

let terminalWorkspacePromise: ReturnType<typeof loadTerminalWorkspace> | null = null;

function loadTerminalWorkspace() {
  return import("../components/TerminalWorkspace").then((module) => ({
    default: module.TerminalWorkspace,
  }));
}

export function preloadTerminalWorkspace(): void {
  terminalWorkspacePromise ??= loadTerminalWorkspace();
  void terminalWorkspacePromise.catch(() => {
    terminalWorkspacePromise = null;
  });
}

const TerminalWorkspace = lazy(() => {
  terminalWorkspacePromise ??= loadTerminalWorkspace();
  return terminalWorkspacePromise;
});
const FilesPanel = lazy(() =>
  import("../components/FilesPanel").then((module) => ({ default: module.FilesPanel })),
);
const WorkbenchBrowser = lazy(() =>
  import("../components/WorkbenchBrowser").then((module) => ({
    default: module.WorkbenchBrowser,
  })),
);
const WorkspaceDiffPanel = lazy(() =>
  import("../components/WorkspaceDiffPanel").then((module) => ({
    default: module.WorkspaceDiffPanel,
  })),
);

export function DirectoryWorkbenchPage(props: {
  machineId: string;
  workspaceId: string;
  active?: boolean;
  retainTerminalConnection?: boolean;
  retainedRoute?: WorkspaceLocation;
}) {
  const { machineId, workspaceId } = props;
  const [ownerId] = useState(() => useAuthStore.getState().user?.id);
  const visible = props.active ?? true;
  const runtime = useWorkbenchRuntime();
  const report = runtime?.report;
  const { platform, platformKind } = useClientHost();
  const router = useRouter();
  const routePath = usePathname();
  const routeSearch = useSearchParams();
  const pathname =
    props.retainedRoute?.pathname ??
    routePath ??
    `/machines/${machineId}/workspaces/${workspaceId}`;
  const searchParamsString = props.retainedRoute?.search ?? routeSearch?.toString() ?? "";
  const openDownloadDirectory = useMemo(
    () =>
      hasCapability(platform, "download-directory")
        ? () => platform.downloads.openDirectory()
        : undefined,
    [platform],
  );
  const machineQuery = useQuery({
    queryKey: ["machine", machineId],
    queryFn: () => api.machines.get(machineId),
    staleTime: 15_000,
    refetchInterval: (query) => workspaceMachinePollInterval(visible, query.state.data),
    refetchOnWindowFocus: visible,
  });
  // 已知电脑在 provisioning 时才挂起下游查询；加载期间与 machine 并行发起，
  // 消除刷新时 machine → workspace/layout/status 的串行瀑布。
  const machineProvisioning = machineQuery.data?.readyAt === null;
  const workspaceQuery = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api.workspaces.get(workspaceId),
    staleTime: 30_000,
    enabled: !machineProvisioning,
  });
  const layoutQuery = useQuery({
    queryKey: ["workbench-layout", workspaceId],
    queryFn: () => api.workbench.getLayout(workspaceId),
    staleTime: 30_000,
    enabled: !machineProvisioning,
  });
  const refetchLayout = layoutQuery.refetch;
  const statusQuery = useQuery({
    queryKey: ["workspace-status", workspaceId],
    queryFn: () => api.workspaces.status(workspaceId),
    staleTime: 15_000,
    refetchInterval: (query) =>
      workspaceStatusPollInterval(visible, machineQuery.data, query.state.data?.state),
    refetchOnWindowFocus: visible,
    enabled: !machineProvisioning,
  });
  const workspacePerformanceKey = `${machineId}:${workspaceId}`;
  useEffect(() => {
    if (visible)
      ensureWorkspaceNavigation(workspacePerformanceKey, {
        client: platformKind,
        temperature: "cold",
      });
  }, [platformKind, visible, workspacePerformanceKey]);
  useEffect(() => {
    if (!visible || !layoutQuery.data) return;
    recordWorkspaceNavigation(
      workspacePerformanceKey,
      CLIENT_PERFORMANCE_MEASURES.workspaceLayoutReady,
    );
  }, [layoutQuery.data, visible, workspacePerformanceKey]);
  useEffect(() => {
    if (!visible || !machineQuery.data || !workspaceQuery.data || !layoutQuery.data) return;
    const frame = requestAnimationFrame(() =>
      recordWorkspaceNavigation(
        workspacePerformanceKey,
        CLIENT_PERFORMANCE_MEASURES.workspaceInteractive,
      ),
    );
    return () => cancelAnimationFrame(frame);
  }, [layoutQuery.data, machineQuery.data, visible, workspacePerformanceKey, workspaceQuery.data]);
  const queryClient = useQueryClient();
  const machineRuntimeAvailable = Boolean(
    machineQuery.data && isMachineRuntimeAvailable(machineQuery.data),
  );
  useEffect(() => {
    // 关机时缓存的 offline 不应让已启动的工作区再等一个常规轮询周期。
    if (visible && machineRuntimeAvailable && statusQuery.data?.state === "offline") {
      void queryClient.invalidateQueries(
        { queryKey: ["workspace-status", workspaceId] },
        { cancelRefetch: false },
      );
    }
  }, [machineRuntimeAvailable, queryClient, statusQuery.data?.state, visible, workspaceId]);
  const recoveryTarget = workspaceRecoveryTarget({
    machineId,
    workspaceId,
    machineNotFound: isNotFoundError(machineQuery.error),
    machineFound: machineQuery.isSuccess,
    workspaceNotFound: isNotFoundError(workspaceQuery.error),
    workspaceMachineId: workspaceQuery.data?.machineId,
  });
  const [layoutState, setLayoutState] = useState<WorkbenchLayout | null>(null);
  const layoutStateRef = useRef<WorkbenchLayout | null>(null);
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileBufferStatus>>({});
  const fileStatusesRef = useRef(fileStatuses);
  const onFileStatusesChange = useCallback(
    (statuses: Record<string, FileBufferStatus>) => {
      if (
        Object.entries(fileStatusesRef.current).some(
          ([path, status]) => status.dirty && statuses[path]?.dirty === false,
        )
      )
        void queryClient.invalidateQueries(
          { queryKey: ["workspace-diff", workspaceId] },
          { cancelRefetch: false },
        );
      fileStatusesRef.current = statuses;
      setFileStatuses(statuses);
    },
    [queryClient, workspaceId],
  );
  const [filesBusy, setFilesBusy] = useState(false);
  const [renamingTerminalId, setRenamingTerminalId] = useState<string | null>(null);
  const [pendingExplorerClose, setPendingExplorerClose] = useState<string | null>(null);
  const [mobileTreeOpenRequest, setMobileTreeOpenRequest] = useState(0);
  const virtualKeyboardOpen = useVirtualKeyboardOpen();
  const { isPhone, isCompact, isResolved: viewportResolved } = useResponsiveViewport();
  const [terminalProcessNames, setTerminalProcessNames] = useState<Record<string, string>>({});
  const [terminalOperationError, setTerminalOperationError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<LayoutSyncState>("idle");
  const syncStateRef = useRef(syncState);
  const layoutRefreshInFlightRef = useRef(false);
  const layoutRefreshMountedRef = useRef(false);
  const previousPageVisibleRef = useRef(visible);
  const lastActiveTerminalIdRef = useRef<string | null>(null);
  const lastWorkspaceTabIdRef = useRef<string | null>(null);
  // 首屏必须直接用已保存布局：useEffect 回填会先画出 EMPTY 的居中空状态，标签栏随后才跳到顶部。
  if (layoutState === null && layoutQuery.data) {
    setLayoutState(layoutQuery.data.layout);
  }
  const layout = layoutState ?? layoutQuery.data?.layout ?? EMPTY_WORKBENCH_LAYOUT;
  useLayoutEffect(() => {
    layoutStateRef.current = layoutState ?? layoutQuery.data?.layout ?? null;
  }, [layoutQuery.data, layoutState]);
  useLayoutEffect(() => {
    syncStateRef.current = syncState;
  }, [syncState]);
  const setTerminalCount = useWorkbenchStore((state) => state.setTerminalCount);

  useEffect(() => {
    if (recoveryTarget && visible && !Object.values(fileStatuses).some((status) => status.dirty))
      router.replace(recoveryTarget);
  }, [recoveryTarget, router, visible, fileStatuses]);

  useEffect(() => {
    if (visible && machineQuery.data?.readyAt === null) {
      router.replace(`/machines/${machineId}/provisioning`);
    }
  }, [machineId, machineQuery.data, router, visible]);

  const saveQueue = useMemo(
    () =>
      createLatestSaveQueue<LayoutSaveRequest, WorkbenchLayoutState>({
        delayMs: 500,
        save: async (request) => {
          if (useAuthStore.getState().user?.id !== ownerId)
            return Promise.reject(new Error("Workspace account changed"));
          let base = request.base;
          let layout = request.layout;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              return await api.workbench.saveLayout(workspaceId, {
                layout,
                expectedRevision: base.revision,
              });
            } catch (error) {
              if (!isApiError(error) || error.code !== "WORKBENCH_LAYOUT_CONFLICT" || attempt === 2)
                throw error;
              const latest = await api.workbench.getLayout(workspaceId);
              layout = rebaseWorkbenchLayout(base.layout, layout, latest.layout);
              base = latest;
              if (workbenchLayoutsEqual(layout, latest.layout)) return latest;
            }
          }
          throw new Error("Workspace layout conflict retry exhausted");
        },
        onSaved: (saved, submitted) => {
          if (useAuthStore.getState().user?.id !== ownerId) return;
          queryClient.setQueryData<WorkbenchLayoutState>(["workbench-layout", workspaceId], saved);
          setLayoutState((current) => {
            if (!current || current === submitted.layout) return saved.layout;
            return rebaseWorkbenchLayout(submitted.layout, current, saved.layout);
          });
        },
        onStatus: setSyncState,
      }),
    [queryClient, workspaceId, ownerId],
  );
  const scheduleSave = useCallback(
    (next: WorkbenchLayout) => {
      const base = queryClient.getQueryData<WorkbenchLayoutState>([
        "workbench-layout",
        workspaceId,
      ]);
      if (layoutStateRef.current && base) {
        syncStateRef.current = "saving";
        saveQueue.schedule({ base, layout: next });
      }
    },
    [queryClient, saveQueue, workspaceId],
  );
  const setLayout = useCallback(
    (update: WorkbenchLayout | ((current: WorkbenchLayout) => WorkbenchLayout)) => {
      const current = layoutStateRef.current;
      if (!current) return;
      const next = typeof update === "function" ? update(current) : update;
      if (next === current) return;
      layoutStateRef.current = next;
      setLayoutState(next);
      scheduleSave(next);
    },
    [scheduleSave],
  );
  const setLayoutImmediate = useCallback(
    (update: WorkbenchLayout | ((current: WorkbenchLayout) => WorkbenchLayout)) => {
      const current = layoutStateRef.current;
      if (!current) return;
      const next = typeof update === "function" ? update(current) : update;
      if (next === current) return;
      layoutStateRef.current = next;
      setLayoutState(next);
      const base = queryClient.getQueryData<WorkbenchLayoutState>([
        "workbench-layout",
        workspaceId,
      ]);
      if (!base) return;
      syncStateRef.current = "saving";
      saveQueue.schedule({ base, layout: next });
      saveQueue.flush();
    },
    [queryClient, saveQueue, workspaceId],
  );
  const retryLayoutSave = useCallback(() => {
    syncStateRef.current = "saving";
    saveQueue.retry();
  }, [saveQueue]);

  useEffect(() => {
    layoutRefreshMountedRef.current = true;
    return () => {
      layoutRefreshMountedRef.current = false;
    };
  }, []);

  const refreshLayoutFromServer = useCallback(async () => {
    if (layoutRefreshInFlightRef.current || layoutRefreshBlocked(syncStateRef.current)) return;
    const snapshot = layoutStateRef.current;
    if (!snapshot) return;
    layoutRefreshInFlightRef.current = true;
    try {
      const result = await refetchLayout({ cancelRefetch: false });
      if (
        !result.isSuccess ||
        !result.data ||
        !layoutRefreshMountedRef.current ||
        useAuthStore.getState().user?.id !== ownerId ||
        layoutStateRef.current !== snapshot ||
        layoutRefreshBlocked(syncStateRef.current)
      )
        return;
      layoutStateRef.current = result.data.layout;
      setLayoutState(result.data.layout);
    } catch {
      // React Query keeps the request error; retain the last usable local layout.
    } finally {
      layoutRefreshInFlightRef.current = false;
    }
  }, [ownerId, refetchLayout]);

  useEffect(() => {
    if (!visible || !viewportResolved || !isPhone) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "hidden") return;
      void refreshLayoutFromServer();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [isPhone, refreshLayoutFromServer, viewportResolved, visible]);

  useEffect(() => {
    if (!viewportResolved || !isPhone) return;
    const wasVisible = previousPageVisibleRef.current;
    previousPageVisibleRef.current = visible;
    if (visible && !wasVisible) void refreshLayoutFromServer();
  }, [isPhone, refreshLayoutFromServer, viewportResolved, visible]);

  const destroyTerminalTab = useCallback(
    async (tab: Extract<WorkbenchTab, { type: "terminal" }>) => {
      await Promise.all(
        terminalPaneIds(tab.root).map((paneId) =>
          destroyTerminalSession(machineId, {
            workspaceId,
            terminalTabId: tab.id,
            paneId,
          }),
        ),
      );
    },
    [machineId, workspaceId],
  );
  useEffect(() => {
    if (!visible) return;
    const next = new URLSearchParams(searchParamsString);
    if (!next.has("session")) return;
    next.delete("session");
    router.replace(`${pathname}${next.size ? `?${next.toString()}` : ""}`);
  }, [visible, pathname, router, searchParamsString]);

  useEffect(() => {
    saveQueue.activate();
    return () => saveQueue.dispose();
  }, [saveQueue]);

  const terminalTabs = layout.workspacePane.tabs.filter(
    (tab): tab is Extract<WorkbenchTab, { type: "terminal" }> => tab.type === "terminal",
  );
  const terminalCount = terminalTabs.length;
  const activeLayoutTab =
    layout.workspacePane.tabs.find((tab) => tab.id === layout.workspacePane.activeTabId) ?? null;
  useEffect(() => {
    if (!activeLayoutTab) return;
    lastWorkspaceTabIdRef.current = activeLayoutTab.id;
    if (activeLayoutTab.type === "terminal") lastActiveTerminalIdRef.current = activeLayoutTab.id;
  }, [activeLayoutTab]);
  const showWorkspaceTab = useCallback(() => {
    setLayout((current) => activatePreferredWorkspaceTab(current, lastWorkspaceTabIdRef.current));
  }, [setLayout]);
  useEffect(() => {
    if (
      !visible ||
      !viewportResolved ||
      !isCompact ||
      activeLayoutTab ||
      layout.workspacePane.tabs.length === 0
    )
      return;
    showWorkspaceTab();
  }, [
    activeLayoutTab,
    isCompact,
    layout.workspacePane.tabs.length,
    showWorkspaceTab,
    viewportResolved,
    visible,
  ]);
  const dirtyCount = Object.values(fileStatuses).filter((status) => status.dirty).length;
  const workspaceBusy =
    machineQuery.isLoading ||
    workspaceQuery.isLoading ||
    layoutQuery.isLoading ||
    filesBusy ||
    syncState === "saving";
  useEffect(() => {
    report?.(`${machineId}:${workspaceId}`, {
      dirty: dirtyCount,
      busy: workspaceBusy,
      unsynced: syncState === "error",
    });
  }, [report, machineId, workspaceId, dirtyCount, workspaceBusy, syncState]);
  useEffect(
    () => () => report?.(`${machineId}:${workspaceId}`, null),
    [report, machineId, workspaceId],
  );
  useEffect(() => {
    const key = `workspace:${workspaceId}`;
    setTerminalCount(key, terminalCount + (layout.applicationPane?.instances.length ?? 0));
    return () => useWorkbenchStore.getState().setTerminalCount(key, 0);
  }, [setTerminalCount, terminalCount, workspaceId, layout.applicationPane?.instances.length]);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.target instanceof Element && event.target.closest('[aria-label="应用对话面板"]'))
        return;
      if (event.key === "`") {
        event.preventDefault();
        setLayoutImmediate((current) => {
          const terminal = [...current.workspacePane.tabs]
            .reverse()
            .find((tab) => tab.type === "terminal");
          return terminal ? activateTab(current, terminal.id) : addTerminalTab(current);
        });
        return;
      }
      if (event.key.toLowerCase() === "w") {
        const tab = layout.workspacePane.tabs.find(
          (candidate) => candidate.id === layout.workspacePane.activeTabId,
        );
        if (!tab) return;
        event.preventDefault();
        if (
          tab.type === "explorer" &&
          exclusiveExplorerDirtyCount(tab.id, fileStatuses, layout.workspacePane.tabs) > 0
        ) {
          setPendingExplorerClose(tab.id);
          return;
        }
        if (tab.type === "terminal") {
          void destroyTerminalTab(tab)
            .then(() => setLayoutImmediate((current) => closeWorkbenchTab(current, tab.id)))
            .catch((error: unknown) =>
              setTerminalOperationError(userErrorMessage(error, "关闭终端失败")),
            );
        } else {
          setLayout((current) => closeWorkbenchTab(current, tab.id));
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    visible,
    fileStatuses,
    layout.workspacePane.activeTabId,
    layout.workspacePane.tabs,
    setLayout,
    setLayoutImmediate,
    destroyTerminalTab,
  ]);

  if (!machineQuery.data || !workspaceQuery.data || !layoutQuery.data) {
    const error = machineQuery.error ?? workspaceQuery.error ?? layoutQuery.error;
    return (
      <div className="flex h-full min-h-0 flex-col">
        {error || recoveryTarget ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
            <p className="text-xs">
              {error ? userErrorMessage(error, "工作台加载失败") : "项目不可访问"}
            </p>
            {error && (
              <button
                className="cm-button"
                onClick={() => {
                  void machineQuery.refetch();
                  void workspaceQuery.refetch();
                  void layoutQuery.refetch();
                }}
              >
                重新加载
              </button>
            )}
          </div>
        ) : (
          // 加载期保持与“零标签”状态一致；伪造标签骨架会在空布局返回后闪现再消失。
          <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col">
            <div
              data-workspace-tabbar
              className="hidden min-h-9 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-2 py-1 sm:flex"
            >
              {!isCompact && (
                <span className="cm-button-primary pointer-events-none shrink-0">
                  <LayoutGrid size={13} /> 应用
                </span>
              )}
              <span className="cm-icon-button pointer-events-none shrink-0">
                <Plus size={14} />
              </span>
            </div>
            <div className="cm-workspace-surface min-h-0 flex-1" />
          </div>
        )}
      </div>
    );
  }

  const machine = machineQuery.data;
  const workspace = workspaceQuery.data;
  const statusKnownUnavailable =
    statusQuery.data !== undefined && statusQuery.data.state !== "available";
  const available =
    !recoveryTarget &&
    !machineQuery.isError &&
    !workspaceQuery.isError &&
    machine.readyAt !== null &&
    isMachineRuntimeAvailable(machine) &&
    !statusKnownUnavailable;
  const showUnavailableBanner = !available && !statusQuery.isPending;
  const activeTab = activeLayoutTab;
  const explorerTabs = layout.workspacePane.tabs.filter(
    (tab): tab is Extract<WorkbenchTab, { type: "explorer" }> => tab.type === "explorer",
  );

  const closeTab = async (tab: WorkbenchTab) => {
    if (
      tab.type === "explorer" &&
      exclusiveExplorerDirtyCount(tab.id, fileStatuses, layout.workspacePane.tabs) > 0
    ) {
      setPendingExplorerClose(tab.id);
      return;
    }
    if (tab.type === "terminal") {
      try {
        await destroyTerminalTab(tab);
      } catch (error) {
        setTerminalOperationError(userErrorMessage(error, "关闭终端失败"));
        return;
      }
    }
    setTerminalOperationError(null);
    setLayoutImmediate((current) => closeWorkbenchTab(current, tab.id));
  };

  const activateMobileTab = (type: WorkbenchTab["type"]) => {
    if (type === "explorer") setMobileTreeOpenRequest((current) => current + 1);
    const rememberedTerminal =
      type === "terminal" && lastActiveTerminalIdRef.current
        ? layout.workspacePane.tabs.find(
            (candidate) =>
              candidate.type === "terminal" && candidate.id === lastActiveTerminalIdRef.current,
          )
        : undefined;
    const existing =
      rememberedTerminal ??
      [...layout.workspacePane.tabs].reverse().find((candidate) => candidate.type === type);
    if (existing) {
      setLayout((current) => activateTab(current, existing.id));
    } else if (type === "explorer") {
      setLayout(addExplorerTab);
    } else if (type === "terminal") {
      setLayoutImmediate(addTerminalTab);
    } else if (type === "diff") {
      setLayout(addDiffTab);
    } else {
      setLayout(addBrowserTab);
    }
  };

  return (
    <ApplicationsWorkbench
      machineId={machineId}
      workspaceId={workspaceId}
      cwd={workspace.path}
      active={visible}
      applicationTabActive={layout.workspacePane.activeTabId === null}
      available={available}
      statusPending={statusQuery.isPending}
      keepConnected={props.retainTerminalConnection ?? visible}
      pane={layout.applicationPane}
      onShowWorkspace={showWorkspaceTab}
      onChange={(update) => setLayout((current) => updateWorkbenchApplicationPane(current, update))}
    >
      {(workspaceVisible, applicationsContent) => (
        <div className="flex h-full min-h-0 flex-col bg-zinc-950">
          {showUnavailableBanner && (
            <div
              role="status"
              className="flex shrink-0 animate-in items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs slide-in-from-top-1 fade-in duration-150"
            >
              <span className="flex-1">项目暂不可用，请稍后重试</span>
              <button
                className="cm-button"
                onClick={() => {
                  void machineQuery.refetch();
                  void workspaceQuery.refetch();
                  void statusQuery.refetch();
                }}
              >
                重试连接
              </button>
            </div>
          )}
          {syncState === "error" && (
            <div className="flex h-8 shrink-0 animate-in items-center gap-2 border-b border-red-900/60 bg-red-950/40 px-3 text-[11px] text-red-300 slide-in-from-top-1 fade-in duration-150">
              <span>布局同步失败</span>
              <button type="button" className="cm-button ml-auto" onClick={retryLayoutSave}>
                重试
              </button>
            </div>
          )}
          {terminalOperationError && (
            <div className="flex min-h-8 shrink-0 animate-in items-center gap-2 border-b px-3 py-1.5 text-xs cm-banner-danger slide-in-from-top-1 fade-in duration-150">
              <span>{terminalOperationError}</span>
              <button
                type="button"
                className="cm-button ml-auto"
                onClick={() => setTerminalOperationError(null)}
              >
                关闭
              </button>
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            <div className="cm-workspace-surface flex h-full min-h-0 flex-col">
              <div
                data-workspace-tabbar
                className="hidden min-h-9 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-2 py-1 sm:flex"
              >
                <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                  <div
                    role="tablist"
                    aria-label="工作台标签"
                    className="flex items-center gap-1"
                    onKeyDown={(event) => {
                      const index = tablistArrowTarget(event);
                      if (index === null) return;
                      event.preventDefault();
                      focusTabAt(event.currentTarget, index);
                      if (!isCompact && index === 0) {
                        setLayout(activateApplicationsTab);
                        return;
                      }
                      const tab = layout.workspacePane.tabs[index - (isCompact ? 0 : 1)];
                      if (tab) setLayout((current) => activateTab(current, tab.id));
                    }}
                  >
                    {!isCompact && (
                      <ApplicationsTabButton
                        active={layout.workspacePane.activeTabId === null}
                        onActivate={() => setLayout(activateApplicationsTab)}
                      />
                    )}
                    {layout.workspacePane.tabs.map((tab) => (
                      <WorkbenchTabButton
                        key={tab.id}
                        tab={tab}
                        label={
                          tab.type === "terminal"
                            ? (terminalProcessNames[`${tab.id}:${tab.activePaneId}`] ??
                              workbenchTabLabel(tab))
                            : tab.type === "explorer" &&
                                !tab.activeFilePath &&
                                explorerTabs.length > 1
                              ? `资源管理器 ${explorerTabs.findIndex((candidate) => candidate.id === tab.id) + 1}`
                              : workbenchTabLabel(tab)
                        }
                        active={tab.id === layout.workspacePane.activeTabId}
                        dirty={
                          tab.type === "explorer" &&
                          Object.values(fileStatuses).some(
                            (status) => status.dirty && status.ownerExplorerIds.includes(tab.id),
                          )
                        }
                        renaming={tab.type === "terminal" && renamingTerminalId === tab.id}
                        onActivate={() => setLayout((current) => activateTab(current, tab.id))}
                        onClose={() => void closeTab(tab)}
                        onRenameStart={() =>
                          tab.type === "terminal" && setRenamingTerminalId(tab.id)
                        }
                        onRename={(title) => {
                          setLayout((current) => updateTerminalTitle(current, tab.id, title));
                          setRenamingTerminalId(null);
                        }}
                        onDrop={(sourceId) =>
                          setLayout((current) => reorderWorkbenchTab(current, sourceId, tab.id))
                        }
                      />
                    ))}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label="新建工作台标签"
                      className="cm-icon-button shrink-0"
                    >
                      <Plus size={14} />
                    </DropdownMenuTrigger>
                    {/* 新标签会移动加号锚点；即时开关，避免退出动画中的菜单随之跳动。 */}
                    <DropdownMenuContent
                      align="start"
                      sideOffset={4}
                      className="w-44 data-closed:hidden"
                      style={{ animation: "none" }}
                    >
                      <DropdownMenuItem
                        disabled={
                          terminalCount >= MAX_TERMINAL_TABS ||
                          layout.workspacePane.tabs.length >= MAX_WORKBENCH_TABS
                        }
                        onClick={() => setLayoutImmediate(addTerminalTab)}
                      >
                        <TerminalSquare size={13} /> 新建终端
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={
                          layout.workspacePane.tabs.length >= MAX_WORKBENCH_TABS &&
                          !layout.workspacePane.tabs.some((tab) => tab.type === "diff")
                        }
                        onClick={() => setLayout(addDiffTab)}
                      >
                        <FileDiff size={13} /> 文件变动
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={layout.workspacePane.tabs.length >= MAX_WORKBENCH_TABS}
                        onClick={() => setLayout(addExplorerTab)}
                      >
                        <FolderTree size={13} /> 资源管理器
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={layout.workspacePane.tabs.length >= MAX_WORKBENCH_TABS}
                        onClick={() => setLayout(addBrowserTab)}
                      >
                        <Globe2 size={13} /> 新建浏览器
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {activeTab?.type === "terminal" && terminalTabs.length > 1 && (
                <MobileTerminalTabBar
                  tabs={terminalTabs}
                  activeTabId={activeTab.id}
                  processNames={terminalProcessNames}
                  onActivate={(tabId) => setLayout((current) => activateTab(current, tabId))}
                />
              )}

              <div className="relative min-h-0 flex-1">
                <Suspense fallback={<div className="cm-workspace-surface h-full" />}>
                  <div
                    className={`absolute inset-0 ${activeTab?.type === "explorer" ? "block" : "hidden"}`}
                  >
                    <FilesPanel
                      machineId={machine.id}
                      workspaceId={workspace.id}
                      rootPath={workspace.path}
                      statusKey={`workspace:${workspace.id}`}
                      active={visible && workspaceVisible && activeTab?.type === "explorer"}
                      available={visible && available}
                      mobileTreeOpenRequest={mobileTreeOpenRequest}
                      onBusyChange={setFilesBusy}
                      onOpenDownloadDirectory={openDownloadDirectory}
                      explorers={explorerTabs}
                      activeExplorerId={activeTab?.type === "explorer" ? activeTab.id : null}
                      onOpenFile={(explorerId, path) =>
                        setLayout((current) => openFileInExplorer(current, explorerId, path))
                      }
                      onTreeLayoutChange={(explorerId, treeSize, treeCollapsed) =>
                        setLayout((current) =>
                          updateExplorerTreeLayout(current, explorerId, treeSize, treeCollapsed),
                        )
                      }
                      onPathMoved={(from, to, directory) =>
                        setLayout((current) => remapExplorerFiles(current, from, to, directory))
                      }
                      onPathRemoved={(path, directory, retainedSelection) =>
                        setLayout((current) =>
                          removeExplorerFiles(current, path, directory, retainedSelection),
                        )
                      }
                      onFileStatusesChange={onFileStatusesChange}
                    />
                  </div>
                </Suspense>

                {layout.workspacePane.tabs.map((tab) => {
                  if (tab.type === "terminal") {
                    return (
                      <KeepAlivePanel
                        key={tab.id}
                        active={activeTab?.id === tab.id}
                        className="cm-terminal-surface"
                      >
                        <Suspense fallback={<div className="cm-terminal-surface h-full" />}>
                          <TerminalWorkspace
                            machineId={machine.id}
                            workspaceId={workspace.id}
                            cwd={workspace.path}
                            tab={tab}
                            active={
                              visible && workspaceVisible && available && activeTab?.id === tab.id
                            }
                            keepConnected={(props.retainTerminalConnection ?? visible) && available}
                            onActivatePane={(paneId) =>
                              setLayout((current) => activateTerminalPane(current, tab.id, paneId))
                            }
                            onSplit={(paneId, orientation) =>
                              setLayoutImmediate((current) =>
                                splitTerminalPane(current, tab.id, paneId, orientation),
                              )
                            }
                            onResizeSplit={(splitId, ratio) =>
                              setLayoutImmediate((current) =>
                                resizeTerminalSplit(current, tab.id, splitId, ratio),
                              )
                            }
                            onClosePane={async (paneId) => {
                              try {
                                await destroyTerminalSession(machine.id, {
                                  workspaceId: workspace.id,
                                  terminalTabId: tab.id,
                                  paneId,
                                });
                                setLayoutImmediate((current) =>
                                  closeTerminalPane(current, tab.id, paneId),
                                );
                              } catch (error) {
                                setTerminalOperationError(
                                  userErrorMessage(error, "关闭终端 Pane 失败"),
                                );
                                throw error;
                              }
                            }}
                            onForegroundProcessChange={(paneId, processName) =>
                              setTerminalProcessNames((current) => {
                                const key = `${tab.id}:${paneId}`;
                                if (processName) {
                                  return current[key] === processName
                                    ? current
                                    : { ...current, [key]: processName };
                                }
                                if (!(key in current)) return current;
                                const next = { ...current };
                                delete next[key];
                                return next;
                              })
                            }
                          />
                        </Suspense>
                      </KeepAlivePanel>
                    );
                  }
                  if (tab.type === "browser") {
                    return (
                      <KeepAlivePanel key={tab.id} active={activeTab?.id === tab.id}>
                        <Suspense fallback={null}>
                          <WorkbenchBrowser
                            machineId={machine.id}
                            url={tab.url}
                            active={
                              visible && workspaceVisible && available && activeTab?.id === tab.id
                            }
                            onUrlChange={(url) =>
                              setLayout((current) => updateBrowserUrl(current, tab.id, url))
                            }
                          />
                        </Suspense>
                      </KeepAlivePanel>
                    );
                  }
                  return null;
                })}

                {!activeTab && applicationsContent}

                {!activeTab && applicationsContent === null && (
                  <div className="flex h-full flex-col items-center justify-center gap-3">
                    <div
                      data-workspace-empty-actions
                      className="flex flex-wrap justify-center gap-2"
                    >
                      <button
                        className="cm-button"
                        type="button"
                        onClick={() => setLayoutImmediate(addTerminalTab)}
                      >
                        <TerminalSquare size={13} /> 新建终端
                      </button>
                      <button
                        className="cm-button"
                        type="button"
                        onClick={() => setLayout(addDiffTab)}
                      >
                        <FileDiff size={13} /> 文件变动
                      </button>
                      <button
                        className="cm-button"
                        type="button"
                        onClick={() => setLayout(addExplorerTab)}
                      >
                        <FolderTree size={13} /> 资源管理器
                      </button>
                      <button
                        className="cm-button"
                        type="button"
                        onClick={() => setLayout(addBrowserTab)}
                      >
                        <Globe2 size={13} /> 新建浏览器
                      </button>
                    </div>
                  </div>
                )}

                {layout.workspacePane.tabs.some((tab) => tab.type === "diff") && (
                  <div
                    className={`absolute inset-0 ${activeTab?.type === "diff" ? "block" : "hidden"}`}
                  >
                    <Suspense fallback={<div className="h-full bg-zinc-950" />}>
                      <WorkspaceDiffPanel
                        workspaceId={workspaceId}
                        available={available && !recoveryTarget}
                        active={visible && workspaceVisible && activeTab?.type === "diff"}
                        statusPending={statusQuery.isPending}
                      />
                    </Suspense>
                  </div>
                )}

                {(!available || recoveryTarget) &&
                  (activeTab !== null || applicationsContent === null) &&
                  activeTab?.type !== "diff" &&
                  dirtyCount === 0 && (
                    <div className="absolute inset-0 z-20 bg-zinc-950/95">
                      <WorkbenchMessage
                        error={
                          statusQuery.data?.state !== "offline" &&
                          statusQuery.data?.state !== undefined
                        }
                        label={
                          !isMachineRuntimeAvailable(machine)
                            ? "电脑未运行，无法打开项目"
                            : statusQuery.data?.state === "missing"
                              ? `路径不存在：${workspace.path}`
                              : statusQuery.data?.state === "not_directory"
                                ? `项目路径不是目录：${workspace.path}`
                                : statusQuery.data?.state === "forbidden"
                                  ? "项目目录超出允许访问范围"
                                  : statusQuery.isPending &&
                                      !machineQuery.isError &&
                                      !workspaceQuery.isError
                                    ? ""
                                    : "电脑通道离线或项目不可用"
                        }
                      />
                    </div>
                  )}
              </div>
            </div>
          </div>

          <nav
            aria-label="移动工作台导航"
            aria-hidden={virtualKeyboardOpen}
            onContextMenu={(event) => event.preventDefault()}
            className={`cm-mobile-workbench-nav grid shrink-0 grid-cols-4 border-t border-zinc-800 bg-zinc-900 sm:hidden ${virtualKeyboardOpen ? "hidden" : ""}`}
          >
            <MobileWorkbenchNavButton
              label="终端"
              active={activeTab?.type === "terminal"}
              icon={<TerminalSquare size={18} />}
              onClick={() => activateMobileTab("terminal")}
            />
            <MobileWorkbenchNavButton
              label="变动"
              active={activeTab?.type === "diff"}
              icon={<FileDiff size={18} />}
              onClick={() => activateMobileTab("diff")}
            />
            <MobileWorkbenchNavButton
              label="文件"
              active={activeTab?.type === "explorer"}
              icon={<FolderTree size={18} />}
              onClick={() => activateMobileTab("explorer")}
            />
            <MobileWorkbenchNavButton
              label="预览"
              active={activeTab?.type === "browser"}
              icon={<Globe2 size={18} />}
              onClick={() => activateMobileTab("browser")}
            />
          </nav>

          <ConfirmDialog
            open={pendingExplorerClose !== null}
            title="关闭资源管理器"
            body={`这个资源管理器还有 ${
              pendingExplorerClose
                ? exclusiveExplorerDirtyCount(
                    pendingExplorerClose,
                    fileStatuses,
                    layout.workspacePane.tabs,
                  )
                : 0
            } 个文件未保存，关闭后将丢失这些修改`}
            confirmLabel="放弃并关闭"
            busy={false}
            onCancel={() => setPendingExplorerClose(null)}
            onConfirm={() => {
              const tabId = pendingExplorerClose;
              setPendingExplorerClose(null);
              if (tabId) setLayoutImmediate((current) => closeWorkbenchTab(current, tabId));
            }}
          />
        </div>
      )}
    </ApplicationsWorkbench>
  );
}

function MobileWorkbenchNavButton(props: {
  label: string;
  active: boolean;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      className={`flex min-h-12 flex-col items-center justify-center gap-0.5 px-1 text-[10px] ${
        props.active ? "text-[var(--cm-accent)]" : "text-zinc-500"
      }`}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function MobileTerminalTabBar(props: {
  tabs: Extract<WorkbenchTab, { type: "terminal" }>[];
  activeTabId: string;
  processNames: Record<string, string>;
  onActivate: (tabId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const selected = selectedRef.current;
    if (!list || !selected) return;
    const reveal = () => {
      const bounds = list.getBoundingClientRect();
      const item = selected.getBoundingClientRect();
      if (item.left < bounds.left) list.scrollLeft += item.left - bounds.left;
      else if (item.right > bounds.right) list.scrollLeft += item.right - bounds.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    observer.observe(selected);
    return () => observer.disconnect();
  }, [props.activeTabId, props.tabs.length]);

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="终端标签"
      onKeyDown={(event) => {
        const index = tablistArrowTarget(event);
        if (index === null) return;
        const tab = props.tabs[index];
        if (!tab) return;
        event.preventDefault();
        focusTabAt(event.currentTarget, index);
        props.onActivate(tab.id);
      }}
      className="cm-terminal-pane-switcher flex min-h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-zinc-800 bg-zinc-900 px-1 sm:hidden"
    >
      {props.tabs.map((tab) => {
        const selected = tab.id === props.activeTabId;
        const label = props.processNames[`${tab.id}:${tab.activePaneId}`] ?? workbenchTabLabel(tab);
        return (
          <button
            key={tab.id}
            ref={selected ? selectedRef : undefined}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={label}
            onClick={() => props.onActivate(tab.id)}
            className={`flex h-7 max-w-36 shrink-0 items-center gap-1 rounded px-2 text-[10px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--cm-accent)] ${
              selected
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
            }`}
          >
            <TerminalSquare size={11} className="shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ApplicationsTabButton(props: { active: boolean; onActivate: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      tabIndex={props.active ? 0 : -1}
      onClick={props.onActivate}
      className={`max-w-52 shrink-0 ${props.active ? "cm-button-primary" : "cm-button"}`}
      title="应用"
    >
      <LayoutGrid size={13} className="shrink-0" />
      <span className="truncate">应用</span>
    </button>
  );
}

function WorkbenchTabButton(props: {
  tab: WorkbenchTab;
  label: string;
  active: boolean;
  dirty: boolean;
  renaming: boolean;
  onActivate: () => void;
  onClose: () => void;
  onRenameStart: () => void;
  onRename: (title: string) => void;
  onDrop: (sourceId: string) => void;
}) {
  const { tab } = props;
  const icon =
    tab.type === "explorer" ? (
      <FolderTree size={13} />
    ) : tab.type === "terminal" ? (
      <TerminalSquare size={13} />
    ) : tab.type === "diff" ? (
      <FileDiff size={13} />
    ) : (
      <Globe2 size={13} />
    );
  return (
    <div
      role="tab"
      tabIndex={props.active ? 0 : -1}
      aria-selected={props.active}
      draggable={!props.renaming}
      onClick={props.onActivate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onActivate();
        }
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-renrencodex-workbench-tab", tab.id);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const sourceId = event.dataTransfer.getData("application/x-renrencodex-workbench-tab");
        if (sourceId && sourceId !== tab.id) props.onDrop(sourceId);
      }}
      onAuxClick={(event) => event.button === 1 && props.onClose()}
      className={`group max-w-52 shrink-0 ${props.active ? "cm-button-primary" : "cm-button"}`}
      title={props.label}
    >
      <span className="shrink-0">{icon}</span>
      {props.renaming && tab.type === "terminal" ? (
        <input
          autoFocus
          defaultValue={tab.title}
          className="h-5 min-w-16 flex-1 rounded border border-zinc-700 bg-zinc-950 px-1 text-[11px] outline-none focus:border-[var(--cm-accent)]"
          onClick={(event) => event.stopPropagation()}
          onBlur={(event) => props.onRename(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") props.onRename(tab.title);
          }}
        />
      ) : (
        <span
          className="min-w-0 flex-1 truncate text-left"
          onDoubleClick={(event) => {
            event.stopPropagation();
            props.onRenameStart();
          }}
        >
          {props.label}
        </span>
      )}
      {props.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />}
      <button
        type="button"
        aria-label={`关闭 ${props.label}`}
        onClick={(event) => {
          event.stopPropagation();
          props.onClose();
        }}
        className={`rounded p-0.5 opacity-60 hover:opacity-100 group-hover:opacity-100 ${
          props.active ? "hover:bg-black/20" : "hover:bg-zinc-700"
        }`}
      >
        <X size={11} />
      </button>
    </div>
  );
}

function KeepAlivePanel({
  active,
  children,
  className = "",
}: {
  active: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`absolute inset-0 ${className} ${active ? "block" : "hidden"}`}>{children}</div>
  );
}

function exclusiveExplorerDirtyCount(
  explorerId: string,
  statuses: Record<string, FileBufferStatus>,
  tabs: WorkbenchTab[],
): number {
  const explorerIds = new Set(tabs.filter((tab) => tab.type === "explorer").map((tab) => tab.id));
  return Object.values(statuses).filter(
    (status) =>
      status.dirty &&
      status.ownerExplorerIds.includes(explorerId) &&
      !status.ownerExplorerIds.some(
        (ownerId) => ownerId !== explorerId && explorerIds.has(ownerId),
      ),
  ).length;
}

function WorkbenchMessage({ label, error = false }: { label: string; error?: boolean }) {
  return (
    <div
      className={`flex h-full min-h-32 items-center justify-center p-6 text-center text-xs ${error ? "text-red-400" : "text-zinc-500"}`}
    >
      {label}
    </div>
  );
}
