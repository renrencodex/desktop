"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./ui/resizable";
import { createPreviewLayoutCoordinator, PreviewLayoutContext } from "../lib/native-preview-layout";
import { VIEWPORT_SYNC_EVENT } from "../lib/visual-viewport";
import { desktopLayoutGate } from "../lib/desktop-layout-state";

const DESKTOP_SIDEBAR_MIN_SIZE_PX = 220;
const DESKTOP_SIDEBAR_MIN_SIZE = `${DESKTOP_SIDEBAR_MIN_SIZE_PX}px`;
const DESKTOP_SIDEBAR_MAX_PERCENT = 36;
const DESKTOP_SIDEBAR_MAX_SIZE = `${DESKTOP_SIDEBAR_MAX_PERCENT}%`;
const DESKTOP_SIDEBAR_RECOVERY_MIN_GROUP_SIZE =
  Math.ceil(DESKTOP_SIDEBAR_MIN_SIZE_PX / (DESKTOP_SIDEBAR_MAX_PERCENT / 100)) + 1;

export function ResponsiveWorkbenchShell(props: {
  isMobile: boolean;
  mobileSidebarOpen: boolean;
  sidebarCollapsed: boolean;
  sidebarSize: number | null;
  desktopSidebar: ReactNode;
  mobileSidebar: ReactNode;
  onCloseMobileSidebar: () => void;
  onDesktopSidebarLayoutChange: (size: number) => void;
  children: ReactNode;
}) {
  const desktopGroupRef = useRef<HTMLDivElement | null>(null);
  const desktopSidebarRef = useRef<PanelImperativeHandle | null>(null);
  const [previewLayout] = useState(createPreviewLayoutCoordinator);
  const appliedCollapsed = useRef(props.sidebarCollapsed);
  const lastExpandedPixels = useRef<number | null>(null);
  const restorePixels = useRef<number | null>(null);
  const deferredIntent = useRef(false);
  useLayoutEffect(() => {
    // A newer user preference supersedes the pre-minimize snapshot.
    restorePixels.current = null;
  }, [props.sidebarCollapsed, props.sidebarSize]);
  const desiredLayout = useRef({
    isMobile: props.isMobile,
    collapsed: props.sidebarCollapsed,
    size: props.sidebarSize,
  });
  useLayoutEffect(() => {
    desiredLayout.current = {
      isMobile: props.isMobile,
      collapsed: props.sidebarCollapsed,
      size: props.sidebarSize,
    };
  }, [props.isMobile, props.sidebarCollapsed, props.sidebarSize]);
  // Defaults must not reflect an uncommitted intent while native previews prepare their covers.
  const [initialLayout] = useState(() => ({
    collapsed: props.sidebarCollapsed,
    size: props.sidebarSize,
  }));

  useEffect(() => {
    const apply = () => {
      if (desktopLayoutGate.isSuspended()) {
        deferredIntent.current = true;
        return;
      }
      if (props.isMobile || props.sidebarCollapsed) {
        desktopSidebarRef.current?.collapse();
      } else {
        desktopSidebarRef.current?.resize(
          props.sidebarSize === null ? DESKTOP_SIDEBAR_MIN_SIZE : `${props.sidebarSize}%`,
        );
      }
      appliedCollapsed.current = props.sidebarCollapsed;
      deferredIntent.current = false;
    };
    if (!props.isMobile && appliedCollapsed.current !== props.sidebarCollapsed) {
      void previewLayout.change(apply);
    } else apply();
    return () => previewLayout.cancel();
  }, [previewLayout, props.isMobile, props.sidebarCollapsed, props.sidebarSize]);

  // Keep the last usable pixel width, not the percentage saved before a later window resize.
  // Native preview preparation can overlap ResizeObserver: retain work arriving while it runs,
  // and verify the result after the panel library has refreshed its own size constraints.
  useEffect(() => {
    const group = desktopGroupRef.current;
    if (!group) return;
    // The panel library only commits pointer-driven layouts on release. Until then the saved
    // intent is stale, so neither a new recovery nor one awaiting preview preparation may apply it.
    // Include panel-edge hit targets, which need not mark a Separator as active.
    let pointerId: number | null = null;
    let frame = 0;
    let recoveryPending = false;
    let dirty = false;
    let disposed = false;
    let attempts = 0;
    let suspended = desktopLayoutGate.isSuspended();

    const rememberSize = () => {
      const intent = desiredLayout.current;
      if (
        desktopLayoutGate.isSuspended() ||
        restorePixels.current !== null ||
        deferredIntent.current ||
        intent.isMobile ||
        intent.collapsed ||
        group.getBoundingClientRect().width < DESKTOP_SIDEBAR_RECOVERY_MIN_GROUP_SIZE
      )
        return;
      const pixels = desktopSidebarRef.current?.getSize().inPixels;
      if (pixels && pixels >= DESKTOP_SIDEBAR_MIN_SIZE_PX - 1) lastExpandedPixels.current = pixels;
    };
    const target = (): string | null => {
      const intent = desiredLayout.current;
      const sidebar = desktopSidebarRef.current;
      if (!sidebar) return null;
      if (intent.isMobile || intent.collapsed) return sidebar.isCollapsed() ? null : "0px";
      if (group.getBoundingClientRect().width < DESKTOP_SIDEBAR_RECOVERY_MIN_GROUP_SIZE)
        return null;
      if (restorePixels.current !== null) {
        const available = Array.from(group.children).reduce(
          (sum, child) =>
            sum + (child.hasAttribute("data-panel") ? child.getBoundingClientRect().width : 0),
          0,
        );
        const pixels = Math.min(
          Math.max(DESKTOP_SIDEBAR_MIN_SIZE_PX, restorePixels.current),
          (available * DESKTOP_SIDEBAR_MAX_PERCENT) / 100,
        );
        if (Math.abs(sidebar.getSize().inPixels - pixels) > 1) return `${pixels}px`;
        restorePixels.current = null;
      }
      if (deferredIntent.current || sidebar.isCollapsed())
        return intent.size === null ? DESKTOP_SIDEBAR_MIN_SIZE : `${intent.size}%`;
      return null;
    };

    const queueRecovery = () => {
      dirty = true;
      if (disposed || recoveryPending) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        dirty = false;
        const sidebar = desktopSidebarRef.current;
        if (
          disposed ||
          pointerId !== null ||
          desktopLayoutGate.isSuspended() ||
          document.visibilityState !== "visible" ||
          !sidebar
        )
          return;
        if (target() === null) {
          rememberSize();
          return;
        }

        recoveryPending = true;
        attempts++;
        void previewLayout
          .change(() => {
            if (disposed || pointerId !== null || desktopLayoutGate.isSuspended()) return;
            const size = target();
            if (size !== null) sidebar.resize(size);
            deferredIntent.current = false;
            appliedCollapsed.current = desiredLayout.current.collapsed;
          })
          .finally(() => {
            recoveryPending = false;
            // Bounded corrective passes; impossible constraints wait for the next real event.
            if (!disposed && (dirty || attempts < 4)) queueRecovery();
          });
      });
    };
    const scheduleRecovery = () => {
      attempts = 0;
      queueRecovery();
    };
    const stopLayout = desktopLayoutGate.subscribe(() => {
      const next = desktopLayoutGate.isSuspended();
      if (next && !suspended) restorePixels.current = lastExpandedPixels.current;
      if (next) pointerId = null;
      suspended = next;
      scheduleRecovery();
    });

    const observer = new ResizeObserver(() => {
      rememberSize();
      scheduleRecovery();
    });
    observer.observe(group);
    const panel = group.querySelector("[data-panel]");
    if (panel) observer.observe(panel);
    const startInteraction = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return;
      pointerId = event.pointerId;
      cancelAnimationFrame(frame);
    };
    const finishInteraction = () => {
      if (pointerId === null) return;
      pointerId = null;
      // The next frame observes the preference committed by the panel library on pointer release.
      scheduleRecovery();
    };
    const releasePointer = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finishInteraction();
    };
    const checkPointer = (event: PointerEvent) => {
      if (event.buttons === 0) releasePointer(event);
    };
    group.addEventListener("pointerdown", startInteraction, true);
    window.addEventListener("pointerup", releasePointer, true);
    window.addEventListener("pointercancel", releasePointer, true);
    window.addEventListener("pointermove", checkPointer, true);
    window.addEventListener("blur", finishInteraction);
    window.addEventListener("contextmenu", finishInteraction, true);
    rememberSize();
    const recoverWhenVisible = () => {
      if (document.visibilityState === "visible") scheduleRecovery();
      else finishInteraction();
    };
    window.addEventListener("focus", scheduleRecovery);
    window.addEventListener("resize", scheduleRecovery);
    window.addEventListener(VIEWPORT_SYNC_EVENT, scheduleRecovery);
    document.addEventListener("visibilitychange", recoverWhenVisible);
    return () => {
      disposed = true;
      stopLayout();
      cancelAnimationFrame(frame);
      observer.disconnect();
      group.removeEventListener("pointerdown", startInteraction, true);
      window.removeEventListener("pointerup", releasePointer, true);
      window.removeEventListener("pointercancel", releasePointer, true);
      window.removeEventListener("pointermove", checkPointer, true);
      window.removeEventListener("blur", finishInteraction);
      window.removeEventListener("contextmenu", finishInteraction, true);
      window.removeEventListener("focus", scheduleRecovery);
      window.removeEventListener("resize", scheduleRecovery);
      window.removeEventListener(VIEWPORT_SYNC_EVENT, scheduleRecovery);
      document.removeEventListener("visibilitychange", recoverWhenVisible);
    };
  }, [previewLayout]);

  const desktopDefaultLayout = initialLayout.collapsed
    ? { sidebar: 0, main: 100 }
    : initialLayout.size === null
      ? undefined
      : { sidebar: initialLayout.size, main: 100 - initialLayout.size };

  return (
    <PreviewLayoutContext.Provider value={previewLayout}>
      {props.isMobile && (
        <button
          type="button"
          aria-label="关闭资源侧栏"
          inert={!props.mobileSidebarOpen}
          aria-hidden={!props.mobileSidebarOpen}
          tabIndex={props.mobileSidebarOpen ? 0 : -1}
          className={`cm-responsive-sidebar-backdrop fixed inset-x-0 z-20 bg-[var(--cm-overlay)] transition-opacity duration-150 ${
            props.mobileSidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          onClick={props.onCloseMobileSidebar}
        />
      )}

      {props.isMobile && (
        <aside
          aria-label="资源侧栏"
          aria-hidden={!props.mobileSidebarOpen}
          inert={!props.mobileSidebarOpen}
          className={`cm-responsive-sidebar cm-sidebar-surface fixed left-0 z-30 flex w-[min(88vw,320px)] shrink-0 flex-col border-r border-zinc-800 transition-transform duration-150 ${
            props.mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          {props.mobileSidebar}
        </aside>
      )}

      <ResizablePanelGroup
        id="desktop-workbench-shell"
        elementRef={desktopGroupRef}
        orientation="horizontal"
        disableCursor
        className="min-w-0 flex-1"
        defaultLayout={desktopDefaultLayout}
        onLayoutChanged={(layout, meta) => {
          if (props.isMobile || desktopLayoutGate.isSuspended() || !meta.isUserInteraction) return;
          props.onDesktopSidebarLayoutChange(layout.sidebar ?? 0);
        }}
      >
        <ResizablePanel
          id="sidebar"
          panelRef={desktopSidebarRef}
          className={props.isMobile ? "hidden" : undefined}
          collapsible
          collapsedSize="0px"
          defaultSize={
            initialLayout.collapsed
              ? "0px"
              : initialLayout.size === null
                ? DESKTOP_SIDEBAR_MIN_SIZE
                : `${initialLayout.size}%`
          }
          minSize={DESKTOP_SIDEBAR_MIN_SIZE}
          maxSize={DESKTOP_SIDEBAR_MAX_SIZE}
          groupResizeBehavior="preserve-pixel-size"
        >
          {!props.isMobile && props.desktopSidebar}
        </ResizablePanel>
        <ResizableHandle
          axis="vertical"
          aria-label="调整资源侧边栏宽度"
          className={
            props.isMobile
              ? "hidden"
              : props.sidebarCollapsed
                ? "pointer-events-none opacity-0 before:w-[2px]"
                : "before:w-[2px]"
          }
        />
        <ResizablePanel id="main" minSize="0px">
          <main className="cm-canvas h-full min-w-0 overflow-hidden">{props.children}</main>
        </ResizablePanel>
      </ResizablePanelGroup>
    </PreviewLayoutContext.Provider>
  );
}
