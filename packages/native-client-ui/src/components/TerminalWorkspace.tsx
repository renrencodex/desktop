import type { TerminalLayoutNode, WorkbenchTab } from "@cloud-machine/api-client";
import { Columns2, Rows2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useResponsiveViewport } from "../lib/responsive";
import {
  canSplitTerminalSize,
  terminalSplitBasis,
  terminalTreeMinimumSize,
  TERMINAL_SPLIT_GAP,
} from "../lib/terminal-pane-sizing";
import { MAX_TERMINAL_PANES, terminalPaneIds } from "../lib/workbench-tabs";
import { Terminal } from "./Terminal";

type TerminalTab = Extract<WorkbenchTab, { type: "terminal" }>;
const PHONE_PANE_CACHE_LIMIT = 3;

function retainedPhonePaneIds(
  recentPaneIds: string[],
  paneIds: string[],
  activePaneId: string,
  active: boolean,
): string[] {
  if (!active) return [activePaneId];
  return [
    ...recentPaneIds.filter((paneId) => paneId !== activePaneId && paneIds.includes(paneId)),
    activePaneId,
  ].slice(-PHONE_PANE_CACHE_LIMIT);
}

export function TerminalWorkspace({
  machineId,
  workspaceId,
  cwd,
  tab,
  active,
  keepConnected,
  onActivatePane,
  onSplit,
  onResizeSplit,
  onClosePane,
  onForegroundProcessChange,
}: {
  machineId: string;
  workspaceId: string;
  cwd: string;
  tab: TerminalTab;
  active: boolean;
  keepConnected: boolean;
  onActivatePane: (paneId: string) => void;
  onSplit: (paneId: string, orientation: "row" | "column") => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onClosePane: (paneId: string) => Promise<void>;
  onForegroundProcessChange: (paneId: string, processName: string | null) => void;
}) {
  const { isPhone, isResolved } = useResponsiveViewport();
  const paneIds = terminalPaneIds(tab.root);
  const activePaneId = paneIds.includes(tab.activePaneId) ? tab.activePaneId : paneIds[0]!;
  const closingPaneIdsRef = useRef(new Set<string>());
  const [closingPaneIds, setClosingPaneIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const livePaneIds = new Set(terminalPaneIds(tab.root));
    const next = new Set(
      [...closingPaneIdsRef.current].filter((paneId) => livePaneIds.has(paneId)),
    );
    if (next.size === closingPaneIdsRef.current.size) return;
    closingPaneIdsRef.current = next;
    setClosingPaneIds(next);
  }, [tab.root]);
  const closePane = (paneId: string) => {
    if (closingPaneIdsRef.current.has(paneId)) return;
    const next = new Set(closingPaneIdsRef.current).add(paneId);
    closingPaneIdsRef.current = next;
    setClosingPaneIds(next);
    void onClosePane(paneId).catch(() => {
      if (!closingPaneIdsRef.current.has(paneId)) return;
      const restored = new Set(closingPaneIdsRef.current);
      restored.delete(paneId);
      closingPaneIdsRef.current = restored;
      setClosingPaneIds(restored);
    });
  };

  // 视口未解析前（SSR/首帧）不渲染分屏结构，避免手机端先闪现桌面布局再跳变。
  if (!isResolved) return <div className="cm-terminal-surface h-full min-h-0" />;

  if (isPhone) {
    return (
      <PhoneTerminalPanes
        machineId={machineId}
        workspaceId={workspaceId}
        cwd={cwd}
        tabId={tab.id}
        paneIds={paneIds}
        activePaneId={activePaneId}
        active={active}
        keepConnected={keepConnected}
        onActivatePane={onActivatePane}
        onSplit={onSplit}
        closingPaneIds={closingPaneIds}
        onClosePane={closePane}
        onForegroundProcessChange={onForegroundProcessChange}
      />
    );
  }

  const minimum = terminalTreeMinimumSize(tab.root);
  return (
    <div
      className="cm-terminal-surface h-full min-h-0 min-w-0 overflow-auto"
      data-terminal-viewport
    >
      <div className="h-full w-full" style={{ minWidth: minimum.width, minHeight: minimum.height }}>
        <TerminalTree
          node={tab.root}
          machineId={machineId}
          workspaceId={workspaceId}
          cwd={cwd}
          tabId={tab.id}
          active={active}
          keepConnected={keepConnected}
          activePaneId={activePaneId}
          paneCount={paneIds.length}
          closingPaneIds={closingPaneIds}
          onActivate={onActivatePane}
          onSplit={onSplit}
          onResizeSplit={onResizeSplit}
          onClose={closePane}
          onForegroundProcessChange={onForegroundProcessChange}
        />
      </div>
    </div>
  );
}

function PhoneTerminalPanes({
  machineId,
  workspaceId,
  cwd,
  tabId,
  paneIds,
  activePaneId,
  active,
  keepConnected,
  onActivatePane,
  onSplit,
  closingPaneIds,
  onClosePane,
  onForegroundProcessChange,
}: {
  machineId: string;
  workspaceId: string;
  cwd: string;
  tabId: string;
  paneIds: string[];
  activePaneId: string;
  active: boolean;
  keepConnected: boolean;
  onActivatePane: (paneId: string) => void;
  onSplit: (paneId: string, orientation: "row" | "column") => void;
  closingPaneIds: ReadonlySet<string>;
  onClosePane: (paneId: string) => void;
  onForegroundProcessChange: (paneId: string, processName: string | null) => void;
}) {
  const paneIdsKey = paneIds.join(":");
  const [connectionActionsHost, setConnectionActionsHost] = useState<HTMLDivElement | null>(null);
  const [cache, setCache] = useState(() => ({
    paneIdsKey,
    activePaneId,
    active,
    recentPaneIds: [activePaneId],
  }));
  // Derive the cache during this render so a newly selected pane is never blank for a frame.
  // React retries this component immediately; no extra committed render or effect is needed.
  let currentCache = cache;
  if (
    cache.paneIdsKey !== paneIdsKey ||
    cache.activePaneId !== activePaneId ||
    cache.active !== active
  ) {
    currentCache = {
      paneIdsKey,
      activePaneId,
      active,
      recentPaneIds: retainedPhonePaneIds(cache.recentPaneIds, paneIds, activePaneId, active),
    };
    setCache(currentCache);
  }
  const retainedIds = currentCache.recentPaneIds;

  return (
    <div className="cm-terminal-surface flex h-full min-h-0 w-full min-w-0 max-w-full flex-col">
      <div className="cm-terminal-pane-toolbar cm-terminal-phone-toolbar flex min-w-0 shrink-0 items-center justify-end gap-0.5 border-b border-zinc-800 bg-zinc-900 px-0.5">
        {paneIds.length > 1 && (
          <PhonePaneSwitcher
            paneIds={paneIds}
            activePaneId={activePaneId}
            onActivate={onActivatePane}
          />
        )}
        <TerminalPaneActions
          paneCount={paneIds.length}
          closing={closingPaneIds.has(activePaneId)}
          canSplit={() => paneIds.length < MAX_TERMINAL_PANES}
          onSplit={(orientation) => onSplit(activePaneId, orientation)}
          onClose={() => onClosePane(activePaneId)}
          connectionActionsRef={setConnectionActionsHost}
        />
      </div>
      <div className="relative min-h-0 min-w-0 flex-1">
        {paneIds
          .filter((paneId) => retainedIds.includes(paneId))
          .map((paneId) => {
            const selected = paneId === activePaneId;
            return (
              <div
                key={paneId}
                className={`absolute inset-0 ${selected ? "block" : "hidden"}`}
                aria-hidden={!selected}
                inert={!selected}
              >
                <TerminalLeaf
                  machineId={machineId}
                  workspaceId={workspaceId}
                  cwd={cwd}
                  tabId={tabId}
                  paneId={paneId}
                  active={active && selected}
                  keepConnected={keepConnected}
                  focused={selected}
                  paneCount={paneIds.length}
                  closing={closingPaneIds.has(paneId)}
                  singlePaneView
                  connectionActionsHost={selected ? connectionActionsHost : null}
                  onActivate={onActivatePane}
                  onSplit={onSplit}
                  onClose={onClosePane}
                  onForegroundProcessChange={onForegroundProcessChange}
                />
              </div>
            );
          })}
      </div>
    </div>
  );
}

function PhonePaneSwitcher({
  paneIds,
  activePaneId,
  onActivate,
}: {
  paneIds: string[];
  activePaneId: string;
  onActivate: (paneId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const selected = selectedRef.current;
    if (!list || !selected) return;
    // 仅滚动标签栏，不使用 scrollIntoView，以免带动工作区或终端视口。
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
  }, [activePaneId, paneIds.length]);
  return (
    <div
      ref={listRef}
      role="group"
      aria-label="终端窗格"
      className="cm-terminal-pane-switcher flex min-w-0 flex-1 items-center overflow-x-auto"
    >
      {paneIds.map((paneId, index) => (
        <button
          key={paneId}
          ref={paneId === activePaneId ? selectedRef : undefined}
          type="button"
          aria-pressed={paneId === activePaneId}
          onClick={() => onActivate(paneId)}
          className="group flex h-7 shrink-0 items-center px-0.5 outline-none"
        >
          <span className="rounded px-2 py-1 text-[11px] font-medium whitespace-nowrap text-zinc-500 transition-colors group-aria-pressed:bg-zinc-800 group-aria-pressed:text-zinc-100 group-focus-visible:ring-1 group-focus-visible:ring-inset group-focus-visible:ring-[var(--cm-accent)]">
            窗格 <span className="tabular-nums">{index + 1}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function TerminalTree(props: {
  node: TerminalLayoutNode;
  machineId: string;
  workspaceId: string;
  cwd: string;
  tabId: string;
  active: boolean;
  keepConnected: boolean;
  activePaneId: string;
  paneCount: number;
  closingPaneIds: ReadonlySet<string>;
  onActivate: (paneId: string) => void;
  onSplit: (paneId: string, orientation: "row" | "column") => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  onClose: (paneId: string) => void;
  onForegroundProcessChange: (paneId: string, processName: string | null) => void;
}) {
  if (props.node.type === "terminal-pane") {
    return (
      <TerminalLeaf
        machineId={props.machineId}
        workspaceId={props.workspaceId}
        cwd={props.cwd}
        tabId={props.tabId}
        paneId={props.node.paneId}
        active={props.active}
        keepConnected={props.keepConnected}
        focused={props.activePaneId === props.node.paneId}
        paneCount={props.paneCount}
        closing={props.closingPaneIds.has(props.node.paneId)}
        onActivate={props.onActivate}
        onSplit={props.onSplit}
        onClose={props.onClose}
        onForegroundProcessChange={props.onForegroundProcessChange}
      />
    );
  }
  return <TerminalSplit {...props} node={props.node} />;
}

function TerminalSplit(
  props: Omit<Parameters<typeof TerminalTree>[0], "node"> & {
    node: Extract<TerminalLayoutNode, { type: "split" }>;
  },
) {
  const groupRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef(0);
  const pendingRef = useRef(props.node.ratio);
  const stopResizeRef = useRef<(() => void) | null>(null);
  const [draftRatio, setDraftRatio] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  useEffect(
    () => () => {
      cancelAnimationFrame(frameRef.current);
      stopResizeRef.current?.();
    },
    [],
  );

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    stopResizeRef.current?.();
    setResizing(true);
    pendingRef.current = props.node.ratio;
    const separator = event.currentTarget;
    const pointerId = event.pointerId;
    separator.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      move.preventDefault();
      const rect = groupRef.current?.getBoundingClientRect();
      if (!rect) return;
      const raw =
        props.node.orientation === "row"
          ? ((move.clientX - rect.left) / Math.max(1, rect.width - TERMINAL_SPLIT_GAP)) * 100
          : ((move.clientY - rect.top) / Math.max(1, rect.height - TERMINAL_SPLIT_GAP)) * 100;
      pendingRef.current = Math.min(85, Math.max(15, raw));
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => setDraftRatio(pendingRef.current));
    };
    const stopResize = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (separator.hasPointerCapture(pointerId)) separator.releasePointerCapture(pointerId);
      stopResizeRef.current = null;
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      onMove(up);
      stopResize();
      cancelAnimationFrame(frameRef.current);
      setDraftRatio(null);
      setResizing(false);
      props.onResizeSplit(props.node.splitId, pendingRef.current);
    };
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId !== pointerId) return;
      stopResize();
      cancelAnimationFrame(frameRef.current);
      setDraftRatio(null);
      setResizing(false);
    };
    stopResizeRef.current = stopResize;
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const firstMinimum = terminalTreeMinimumSize(props.node.first);
  const secondMinimum = terminalTreeMinimumSize(props.node.second);
  const axis = props.node.orientation === "row" ? "width" : "height";
  const firstStyle = {
    flexBasis: terminalSplitBasis(
      draftRatio ?? props.node.ratio,
      firstMinimum[axis],
      secondMinimum[axis],
    ),
    flexGrow: 0,
    flexShrink: 0,
  };
  return (
    <div
      ref={groupRef}
      className={`flex h-full min-h-0 min-w-0 ${props.node.orientation === "row" ? "flex-row" : "flex-col"}`}
    >
      <div className="relative z-0 min-h-0 min-w-0 overflow-hidden" style={firstStyle}>
        <TerminalTree {...props} node={props.node.first} />
      </div>
      <div
        role="separator"
        data-terminal-split
        // Overlap adjacent panes by 2px on each side: a 5px drag target costs 1px.
        style={{ flexBasis: TERMINAL_SPLIT_GAP + 4 }}
        data-separator={resizing ? "active" : "idle"}
        aria-orientation={props.node.orientation === "row" ? "vertical" : "horizontal"}
        onPointerDown={beginResize}
        className={
          props.node.orientation === "row"
            ? "group relative z-10 -mx-0.5 shrink-0 touch-none select-none cursor-col-resize before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-zinc-800 before:transition-[width,background-color] before:duration-150 hover:before:w-[3px] hover:before:bg-[var(--cm-accent)] data-[separator=active]:before:w-[3px] data-[separator=active]:before:bg-[var(--cm-accent)]"
            : "group relative z-10 -my-0.5 shrink-0 touch-none select-none cursor-row-resize before:absolute before:inset-x-0 before:top-1/2 before:h-px before:-translate-y-1/2 before:bg-zinc-800 before:transition-[height,background-color] before:duration-150 hover:before:h-[3px] hover:before:bg-[var(--cm-accent)] data-[separator=active]:before:h-[3px] data-[separator=active]:before:bg-[var(--cm-accent)]"
        }
      />
      <div className="relative z-0 min-h-0 min-w-0 flex-1 overflow-hidden">
        <TerminalTree {...props} node={props.node.second} />
      </div>
    </div>
  );
}

function TerminalLeaf({
  machineId,
  workspaceId,
  cwd,
  tabId,
  paneId,
  active,
  keepConnected,
  focused = true,
  paneCount,
  closing = false,
  singlePaneView = false,
  connectionActionsHost,
  onActivate,
  onSplit,
  onClose,
  onForegroundProcessChange,
}: {
  machineId: string;
  workspaceId: string;
  cwd: string;
  tabId: string;
  paneId: string;
  active: boolean;
  keepConnected: boolean;
  focused?: boolean;
  paneCount: number;
  closing?: boolean;
  singlePaneView?: boolean;
  connectionActionsHost?: HTMLElement | null;
  onActivate: (paneId: string) => void;
  onSplit: (paneId: string, orientation: "row" | "column") => void;
  onClose: (paneId: string) => void;
  onForegroundProcessChange: (paneId: string, processName: string | null) => void;
}) {
  const paneRef = useRef<HTMLElement | null>(null);
  const [localActionsHost, setLocalActionsHost] = useState<HTMLDivElement | null>(null);
  const [splitSpace, setSplitSpace] = useState({ row: false, column: false });
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const measure = () => {
      const rect = pane.getBoundingClientRect();
      const row = canSplitTerminalSize(rect, "row");
      const column = canSplitTerminalSize(rect, "column");
      setSplitSpace((previous) =>
        previous.row === row && previous.column === column ? previous : { row, column },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);
  const canSplit = (orientation: "row" | "column") =>
    paneCount < MAX_TERMINAL_PANES && (singlePaneView || splitSpace[orientation]);
  const split = (orientation: "row" | "column") => {
    // Recheck live geometry in case a resize happened before ResizeObserver ran.
    const rect = paneRef.current?.getBoundingClientRect();
    if (
      paneCount < MAX_TERMINAL_PANES &&
      (singlePaneView || (rect && canSplitTerminalSize(rect, orientation)))
    )
      onSplit(paneId, orientation);
  };
  return (
    <section
      ref={paneRef}
      data-terminal-pane-id={paneId}
      className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden transition-[box-shadow] duration-150 ${focused ? "ring-1 ring-inset ring-[var(--cm-accent)]" : ""}`}
      onPointerDown={() => onActivate(paneId)}
      onFocusCapture={() => onActivate(paneId)}
      aria-label="终端 Pane"
    >
      {!singlePaneView && (
        <div className="cm-terminal-pane-toolbar flex shrink-0 items-center justify-end gap-0.5 border-b border-zinc-800 bg-zinc-900 px-0.5">
          <TerminalPaneActions
            paneCount={paneCount}
            closing={closing}
            canSplit={canSplit}
            onSplit={split}
            onClose={() => onClose(paneId)}
            connectionActionsRef={setLocalActionsHost}
          />
        </div>
      )}
      <div className="min-h-0 min-w-0 flex-1">
        <Terminal
          machineId={machineId}
          workspaceId={workspaceId}
          terminalTabId={tabId}
          paneId={paneId}
          cwd={cwd}
          active={active}
          keepConnected={keepConnected}
          focused={focused}
          closing={closing}
          connectionActionsHost={singlePaneView ? connectionActionsHost : localActionsHost}
          onForegroundProcessChange={(processName) =>
            onForegroundProcessChange(paneId, processName)
          }
        />
      </div>
    </section>
  );
}

function TerminalPaneActions({
  paneCount,
  closing,
  canSplit,
  onSplit,
  onClose,
  connectionActionsRef,
}: {
  paneCount: number;
  closing: boolean;
  canSplit: (orientation: "row" | "column") => boolean;
  onSplit: (orientation: "row" | "column") => void;
  onClose: () => void;
  connectionActionsRef: (node: HTMLDivElement | null) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <div ref={connectionActionsRef} className="shrink-0" />
      <button
        type="button"
        className="cm-icon-button"
        disabled={closing || !canSplit("row")}
        aria-label="向右分屏"
        title={
          paneCount >= MAX_TERMINAL_PANES
            ? `已达到 ${MAX_TERMINAL_PANES} 分屏上限`
            : !canSplit("row")
              ? "空间不足，无法向右分屏"
              : "向右分屏"
        }
        onClick={() => onSplit("row")}
      >
        <Columns2 size={12} />
      </button>
      <button
        type="button"
        className="cm-icon-button"
        disabled={closing || !canSplit("column")}
        aria-label="向下分屏"
        title={
          paneCount >= MAX_TERMINAL_PANES
            ? `已达到 ${MAX_TERMINAL_PANES} 分屏上限`
            : !canSplit("column")
              ? "空间不足，无法向下分屏"
              : "向下分屏"
        }
        onClick={() => onSplit("column")}
      >
        <Rows2 size={12} />
      </button>
      <button
        type="button"
        className="cm-icon-button"
        disabled={closing}
        aria-label="关闭 Pane"
        title="关闭 Pane"
        onClick={onClose}
      >
        <X size={12} />
      </button>
    </div>
  );
}
