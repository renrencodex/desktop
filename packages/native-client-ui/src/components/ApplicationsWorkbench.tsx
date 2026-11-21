"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_APPLICATION_PANE,
  type ApplicationPane,
  type CliAppId,
} from "@cloud-machine/client-contracts";
import {
  CLI_STORE_CONNECTION_POLL_INTERVAL_MS,
  CLIENT_PERFORMANCE_MEASURES,
  canLaunchCliApp,
  cliStoreInventoryPollInterval,
  closeCliApplication,
  mergeCliCatalog,
  openCliApplication,
  recordWorkspaceNavigation,
  sortInstalledCliApps,
} from "@cloud-machine/workspace-ui";
import { LayoutGrid } from "lucide-react";

import { api } from "../lib/api";
import { useResponsiveViewport } from "../lib/responsive";
import { destroyTerminalSession } from "../lib/terminal-channel";
import { userErrorMessage } from "../lib/user-error";
import { useAuthStore } from "../stores/auth";
import { CliAppIcon } from "./CliAppIcon";
import { MobileTitlebarPortal } from "./MobileTitlebarPortal";
import { Terminal } from "./Terminal";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";

export function ApplicationsWorkbench(props: {
  machineId: string;
  workspaceId: string;
  cwd: string;
  active: boolean;
  applicationTabActive: boolean;
  available: boolean;
  statusPending: boolean;
  keepConnected: boolean;
  pane?: ApplicationPane;
  onChange: (update: ApplicationPane | ((current: ApplicationPane) => ApplicationPane)) => void;
  onShowWorkspace: () => void;
  children: (visible: boolean, applicationsContent: ReactNode | null) => ReactNode;
}) {
  const pane = props.pane ?? DEFAULT_APPLICATION_PANE;
  const containerRef = useRef<HTMLDivElement>(null);
  const [connectionActionsHost, setConnectionActionsHost] = useState<HTMLDivElement | null>(null);
  const closingInstanceIdRef = useRef<string | null>(null);
  const previousConnectionOnlineRef = useRef<boolean | undefined>(undefined);
  const { isCompact, isPhone } = useResponsiveViewport();
  const accountId = useAuthStore((state) => state.user?.id);
  const activeInstance = pane.instances.find((item) => item.id === pane.activeInstanceId);
  const mobileView = pane.compactView;
  const showConversation = !pane.collapsed && Boolean(activeInstance);
  const applicationSurfaceActive =
    props.active &&
    (isCompact ? mobileView === "applications" : props.applicationTabActive || showConversation);
  const inventory = useQuery({
    queryKey: ["cli-store", accountId, props.machineId],
    queryFn: () => api.cliStore.inventory(props.machineId),
    enabled: props.active,
    staleTime: 15_000,
    retry: false,
    refetchInterval: (query) =>
      cliStoreInventoryPollInterval(props.active, query.state.data?.operation),
  });
  const connection = useQuery({
    queryKey: ["machine-connection", accountId, props.machineId],
    queryFn: () => api.machines.connection(props.machineId),
    enabled: props.active,
    staleTime: 15_000,
    retry: false,
    refetchInterval: applicationSurfaceActive ? CLI_STORE_CONNECTION_POLL_INTERVAL_MS : false,
  });
  const catalog = useQuery({
    queryKey: ["cli-store-catalog", accountId],
    queryFn: () => api.cliStore.catalog(),
    enabled: props.active,
    staleTime: 5 * 60_000,
    retry: false,
    refetchInterval: props.active ? 15_000 : false,
  });
  const apps = mergeCliCatalog(catalog.data ?? [], inventory.data?.installations ?? []);
  const installedApps = sortInstalledCliApps(apps, inventory.data?.installations ?? []);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState(0);
  const [closingInstanceId, setClosingInstanceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connectionOnline = connection.data?.online ?? inventory.data?.online;
  const refetchInventory = inventory.refetch;

  useEffect(() => {
    if (!props.active || !inventory.data || !catalog.data) return;
    recordWorkspaceNavigation(
      `${props.machineId}:${props.workspaceId}`,
      CLIENT_PERFORMANCE_MEASURES.applicationsReady,
    );
  }, [catalog.data, inventory.data, props.active, props.machineId, props.workspaceId]);

  useEffect(() => {
    const reconnected =
      applicationSurfaceActive &&
      previousConnectionOnlineRef.current === false &&
      connectionOnline === true;
    previousConnectionOnlineRef.current = connectionOnline;
    if (reconnected) void refetchInventory();
  }, [applicationSurfaceActive, connectionOnline, refetchInventory]);

  const showCatalog = () => {
    props.onChange((current) => ({
      ...current,
      collapsed: true,
      compactView: "applications",
    }));
  };

  const launch = (appId: CliAppId, fresh = false) => {
    if (
      pane.instances.length >= 16 &&
      (fresh || !pane.instances.some((item) => item.appId === appId && item.mode === "run"))
    ) {
      setError("最多打开 16 个应用实例，请先关闭一个实例");
      return;
    }
    props.onChange((current) => openCliApplication(current, appId, fresh));
    props.onShowWorkspace();
    setTerminalFocusRequest((current) => current + 1);
    setError(null);
  };

  const closeInstance = (id: string) => {
    if (closingInstanceIdRef.current) return;
    closingInstanceIdRef.current = id;
    setClosingInstanceId(id);
    setError(null);
    void destroyTerminalSession(props.machineId, {
      workspaceId: props.workspaceId,
      terminalTabId: id,
      paneId: id,
    })
      .then(() => props.onChange((current) => closeCliApplication(current, id)))
      .catch((failure) => setError(userErrorMessage(failure, "关闭应用失败")))
      .finally(() => {
        if (closingInstanceIdRef.current !== id) return;
        closingInstanceIdRef.current = null;
        setClosingInstanceId(null);
      });
  };

  const applicationsCatalog = (
    <section className="h-full overflow-auto p-4" aria-label="应用目录">
      <h2 className="text-sm font-medium">应用</h2>
      <p className="mt-1 text-xs text-zinc-500">
        {isCompact ? "点击图标打开，长按可新建实例。" : "双击图标打开，右键可新建实例。"}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {error}
        </p>
      )}
      {inventory.error && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          应用状态查询失败{" "}
          <button className="cm-button" onClick={() => void inventory.refetch()}>
            重试
          </button>
        </p>
      )}
      {!props.available && !props.statusPending && (
        <p className="mt-2 text-xs text-zinc-500">电脑当前不可用，启动并连接后可以运行应用。</p>
      )}
      {props.available && connectionOnline === false && !connection.isPending && (
        <p className="mt-2 text-xs text-zinc-500">电脑通信暂时中断，恢复连接后可以运行应用。</p>
      )}
      <div className="mt-4 grid grid-cols-[repeat(auto-fill,3.5rem)] gap-x-1.5 gap-y-2.5">
        {installedApps.map((app) => {
          const enabled =
            props.available &&
            connectionOnline === true &&
            inventory.data?.online &&
            canLaunchCliApp(inventory.data, app.id) &&
            !inventory.error;
          return (
            <article key={app.id} className="group min-w-0 text-center">
              <ContextMenu>
                <ContextMenuTrigger
                  className="relative mx-auto w-fit"
                  onClickCapture={(event) => {
                    if (event.currentTarget.hasAttribute("data-popup-open")) {
                      event.preventDefault();
                      event.stopPropagation();
                    }
                  }}
                >
                  <button
                    type="button"
                    className="block rounded-[22%] transition-transform duration-150 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cm-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transform-none"
                    aria-label={`打开 ${app.name}`}
                    disabled={!enabled}
                    onDoubleClick={() => launch(app.id)}
                    onClick={(event) => {
                      if (isCompact || event.detail === 0) launch(app.id);
                    }}
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-[22%] border border-[var(--cm-border)] bg-[var(--cm-surface-panel)] text-[var(--foreground)] shadow-[var(--cm-panel-shadow)] transition-[background-color,box-shadow] group-hover:bg-[var(--cm-surface-hover)] group-hover:shadow-md sm:h-11 sm:w-11">
                      <CliAppIcon appId={app.id} icon={app.icon} size={22} />
                    </span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem disabled={!enabled} onClick={() => launch(app.id, true)}>
                    新建实例
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              <p
                className="mt-1.5 truncate px-0.5 text-[10px] leading-tight font-medium text-zinc-200"
                title={app.name}
              >
                {app.name}
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );

  const conversation = (
    <section className="flex h-full min-h-0 flex-col" aria-label="应用对话面板">
      <div className="cm-application-instance-tabs flex min-h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 px-2 py-1">
        {isCompact && (
          <button
            className="cm-application-catalog-tab cm-icon-button shrink-0"
            aria-label="打开应用目录"
            onClick={showCatalog}
          >
            <LayoutGrid size={14} />
          </button>
        )}
        <div ref={setConnectionActionsHost} className="shrink-0" />
        {pane.instances.map((item, index) => (
          <div
            key={item.id}
            className="cm-application-instance-tab-group flex shrink-0 items-center gap-1"
          >
            <button
              className={`cm-application-instance-tab ${pane.activeInstanceId === item.id ? "cm-button-primary" : "cm-button"}`}
              onClick={() => {
                props.onChange((current) => ({
                  ...current,
                  collapsed: false,
                  compactView: "applications",
                  activeInstanceId: item.id,
                }));
                setTerminalFocusRequest((current) => current + 1);
              }}
            >
              {apps.find((app) => app.id === item.appId)?.name ?? item.appId}
              {` ${index + 1}`}
            </button>
            <button
              className="cm-application-instance-close cm-icon-button"
              aria-label={`关闭应用实例 ${index + 1}`}
              disabled={closingInstanceId !== null}
              onClick={() => closeInstance(item.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="p-2 text-xs text-red-400">
          {error}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        {pane.instances.map((instance) => (
          <div
            key={instance.id}
            className="absolute inset-0"
            hidden={pane.activeInstanceId !== instance.id}
          >
            <Terminal
              machineId={props.machineId}
              workspaceId={props.workspaceId}
              cwd={props.cwd}
              terminalTabId={instance.id}
              paneId={instance.id}
              launchProfile={{ appId: instance.appId, mode: instance.mode }}
              connectionActionsHost={
                pane.activeInstanceId === instance.id ? connectionActionsHost : null
              }
              active={
                props.active &&
                props.available &&
                showConversation &&
                pane.activeInstanceId === instance.id &&
                (!isCompact || mobileView === "applications")
              }
              keepConnected={props.keepConnected && props.available}
              closing={closingInstanceId === instance.id}
              focusRequest={
                pane.activeInstanceId === instance.id ? terminalFocusRequest : undefined
              }
            />
          </div>
        ))}
      </div>
    </section>
  );

  const applicationViewSwitcher = (
    <div
      className={`cm-application-view-switcher flex shrink-0 gap-2 ${
        isPhone ? "items-center" : "border-b border-zinc-800 p-1"
      }`}
    >
      <button
        className={`cm-application-view-tab ${mobileView === "applications" ? "cm-button-primary" : "cm-button"}`}
        onClick={() => {
          props.onChange((current) => ({ ...current, compactView: "applications" }));
          if (showConversation) setTerminalFocusRequest((current) => current + 1);
        }}
      >
        应用
      </button>
      <button
        className={`cm-application-view-tab ${mobileView === "workspace" ? "cm-button-primary" : "cm-button"}`}
        onClick={() => {
          props.onShowWorkspace();
          props.onChange((current) => ({ ...current, compactView: "workspace" }));
        }}
      >
        工作区
      </button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {isCompact && !isPhone && applicationViewSwitcher}
      {isPhone && props.active && (
        <MobileTitlebarPortal>{applicationViewSwitcher}</MobileTitlebarPortal>
      )}
      <div ref={containerRef} className="flex min-h-0 flex-1">
        <div
          className="min-h-0 min-w-0 shrink-0"
          style={{
            width: isCompact ? "100%" : `${pane.size}%`,
            display: isCompact
              ? mobileView === "applications"
                ? undefined
                : "none"
              : showConversation
                ? undefined
                : "none",
          }}
        >
          {isCompact && (
            <div className={`h-full ${showConversation ? "hidden" : "block"}`}>
              {applicationsCatalog}
            </div>
          )}
          <div className={`h-full ${isCompact && !showConversation ? "hidden" : "block"}`}>
            {conversation}
          </div>
        </div>
        <div
          role="separator"
          aria-label="调整应用对话面板宽度"
          aria-orientation="vertical"
          aria-valuemin={20}
          aria-valuemax={70}
          aria-valuenow={pane.size}
          tabIndex={!isCompact && showConversation ? 0 : -1}
          className="relative z-10 -mx-px w-[3px] shrink-0 cursor-col-resize touch-none outline-none before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-[2px] before:-translate-x-1/2 before:bg-[var(--cm-border)] before:content-[''] before:opacity-40 before:transition-[width,background-color,opacity] before:duration-150 hover:before:w-[3px] hover:before:bg-[var(--cm-accent)] hover:before:opacity-100 focus-visible:before:w-[3px] focus-visible:before:bg-[var(--cm-accent)] focus-visible:before:opacity-100 active:before:w-[3px] active:before:bg-[var(--cm-accent)] active:before:opacity-100 [@media(pointer:coarse)]:-mx-[12px] [@media(pointer:coarse)]:w-[25px]"
          style={{ display: !isCompact && showConversation ? undefined : "none" }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              const delta = event.key === "ArrowLeft" ? -2 : 2;
              props.onChange((current) => ({
                ...current,
                size: Math.max(20, Math.min(70, current.size + delta)),
              }));
            }
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const bounds = containerRef.current?.getBoundingClientRect();
            if (bounds?.width) {
              const size = Math.max(
                20,
                Math.min(70, ((event.clientX - bounds.left) / bounds.width) * 100),
              );
              props.onChange((current) => ({ ...current, size }));
            }
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
        />
        <div
          className="min-h-0 min-w-0 flex-1"
          style={{ display: isCompact && mobileView !== "workspace" ? "none" : undefined }}
        >
          {props.children(
            !isCompact || mobileView === "workspace",
            isCompact ? null : applicationsCatalog,
          )}
        </div>
      </div>
    </div>
  );
}
