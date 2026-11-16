import type { TerminalLayoutNode, WorkbenchLayout, WorkbenchTab } from "@cloud-machine/api-client";
import { MAX_TERMINAL_PANES } from "@cloud-machine/client-contracts";

import { baseName, normalizePath, remapMovedPath } from "./fs-utils";

export const MAX_WORKBENCH_TABS = 32;
export const MAX_TERMINAL_TABS = 6;
export const DEFAULT_EXPLORER_TREE_SIZE = 28;
export const MIN_EXPLORER_TREE_SIZE = 15;
export const MAX_EXPLORER_TREE_SIZE = 45;

export { MAX_TERMINAL_PANES } from "@cloud-machine/client-contracts";

export const EMPTY_WORKBENCH_LAYOUT: WorkbenchLayout = {
  version: 9,
  workspacePane: {
    tabs: [],
    activeTabId: null,
  },
};

function newTabId(): string {
  return `tab_${crypto.randomUUID()}`;
}

export function activateTab(layout: WorkbenchLayout, tabId: string): WorkbenchLayout {
  return layout.workspacePane.activeTabId !== tabId &&
    layout.workspacePane.tabs.some((tab) => tab.id === tabId)
    ? { ...layout, workspacePane: { ...layout.workspacePane, activeTabId: tabId } }
    : layout;
}

export function activateApplicationsTab(layout: WorkbenchLayout): WorkbenchLayout {
  return layout.workspacePane.activeTabId === null
    ? layout
    : { ...layout, workspacePane: { ...layout.workspacePane, activeTabId: null } };
}

export function activatePreferredWorkspaceTab(
  layout: WorkbenchLayout,
  preferredTabId: string | null,
): WorkbenchLayout {
  const activeTabId =
    (preferredTabId && layout.workspacePane.tabs.some((tab) => tab.id === preferredTabId)
      ? preferredTabId
      : layout.workspacePane.tabs[0]?.id) ?? null;
  return layout.workspacePane.activeTabId === activeTabId
    ? layout
    : { ...layout, workspacePane: { ...layout.workspacePane, activeTabId } };
}

export function addExplorerTab(layout: WorkbenchLayout): WorkbenchLayout {
  return appendTab(layout, {
    id: newTabId(),
    type: "explorer",
    activeFilePath: null,
    treeSize: DEFAULT_EXPLORER_TREE_SIZE,
    treeCollapsed: false,
  });
}

export function addDiffTab(layout: WorkbenchLayout): WorkbenchLayout {
  const existing = layout.workspacePane.tabs.find((tab) => tab.type === "diff");
  return existing
    ? activateTab(layout, existing.id)
    : appendTab(layout, { id: newTabId(), type: "diff" });
}

export function addTerminalTab(layout: WorkbenchLayout): WorkbenchLayout {
  const tabs = layout.workspacePane.tabs;
  if (
    tabs.length >= MAX_WORKBENCH_TABS ||
    tabs.filter((tab) => tab.type === "terminal").length >= MAX_TERMINAL_TABS
  ) {
    return layout;
  }
  const id = newTabId();
  return appendTab(layout, {
    id,
    type: "terminal",
    title: "终端",
    activePaneId: id,
    root: { type: "terminal-pane", paneId: id },
  });
}

export function terminalPaneIds(node: TerminalLayoutNode): string[] {
  return node.type === "terminal-pane"
    ? [node.paneId]
    : [...terminalPaneIds(node.first), ...terminalPaneIds(node.second)];
}

function replaceTerminalNode(
  node: TerminalLayoutNode,
  paneId: string,
  replacement: (leaf: Extract<TerminalLayoutNode, { type: "terminal-pane" }>) => TerminalLayoutNode,
): TerminalLayoutNode {
  if (node.type === "terminal-pane") return node.paneId === paneId ? replacement(node) : node;
  const first = replaceTerminalNode(node.first, paneId, replacement);
  const second = replaceTerminalNode(node.second, paneId, replacement);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function splitTerminalPane(
  layout: WorkbenchLayout,
  tabId: string,
  paneId: string,
  orientation: "row" | "column",
): WorkbenchLayout {
  return updateTab(layout, tabId, (tab) => {
    if (tab.type !== "terminal" || terminalPaneIds(tab.root).length >= MAX_TERMINAL_PANES)
      return tab;
    const nextPaneId = newTabId();
    const root = replaceTerminalNode(tab.root, paneId, (leaf) => ({
      type: "split",
      splitId: newTabId(),
      orientation,
      ratio: 50,
      first: leaf,
      second: { type: "terminal-pane", paneId: nextPaneId },
    }));
    return root === tab.root ? tab : { ...tab, root, activePaneId: nextPaneId };
  });
}

function removeTerminalNode(node: TerminalLayoutNode, paneId: string): TerminalLayoutNode | null {
  if (node.type === "terminal-pane") return node.paneId === paneId ? null : node;
  const first = removeTerminalNode(node.first, paneId);
  const second = removeTerminalNode(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function closeTerminalPane(
  layout: WorkbenchLayout,
  tabId: string,
  paneId: string,
): WorkbenchLayout {
  const tab = layout.workspacePane.tabs.find((candidate) => candidate.id === tabId);
  if (!tab || tab.type !== "terminal") return layout;
  const root = removeTerminalNode(tab.root, paneId);
  if (!root) return closeWorkbenchTab(layout, tabId);
  const paneIds = terminalPaneIds(root);
  return updateTab(layout, tabId, (candidate) =>
    candidate.type === "terminal"
      ? {
          ...candidate,
          root,
          activePaneId: paneIds.includes(candidate.activePaneId)
            ? candidate.activePaneId
            : paneIds[0]!,
        }
      : candidate,
  );
}

export function activateTerminalPane(
  layout: WorkbenchLayout,
  tabId: string,
  paneId: string,
): WorkbenchLayout {
  return updateTab(layout, tabId, (tab) =>
    tab.type === "terminal" &&
    tab.activePaneId !== paneId &&
    terminalPaneIds(tab.root).includes(paneId)
      ? { ...tab, activePaneId: paneId }
      : tab,
  );
}

export function resizeTerminalSplit(
  layout: WorkbenchLayout,
  tabId: string,
  splitId: string,
  ratio: number,
): WorkbenchLayout {
  const normalized = Math.min(85, Math.max(15, ratio));
  const updateNode = (node: TerminalLayoutNode): TerminalLayoutNode => {
    if (node.type === "terminal-pane") return node;
    if (node.splitId === splitId) return { ...node, ratio: normalized };
    const first = updateNode(node.first);
    const second = updateNode(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  return updateTab(layout, tabId, (tab) => {
    if (tab.type !== "terminal") return tab;
    const root = updateNode(tab.root);
    return root === tab.root ? tab : { ...tab, root };
  });
}

export function addBrowserTab(layout: WorkbenchLayout, url = ""): WorkbenchLayout {
  return appendTab(layout, { id: newTabId(), type: "browser", url });
}

export function openFileInExplorer(
  layout: WorkbenchLayout,
  explorerId: string,
  path: string,
): WorkbenchLayout {
  const normalized = normalizePath(path);
  return updateTab(layout, explorerId, (tab) =>
    tab.type === "explorer" && tab.activeFilePath !== normalized
      ? { ...tab, activeFilePath: normalized }
      : tab,
  );
}

export function updateExplorerTreeLayout(
  layout: WorkbenchLayout,
  explorerId: string,
  treeSize: number,
  treeCollapsed: boolean,
): WorkbenchLayout {
  const normalizedSize = Math.min(
    MAX_EXPLORER_TREE_SIZE,
    Math.max(MIN_EXPLORER_TREE_SIZE, treeSize),
  );
  return updateTab(layout, explorerId, (tab) =>
    tab.type === "explorer" &&
    (tab.treeSize !== normalizedSize || tab.treeCollapsed !== treeCollapsed)
      ? { ...tab, treeSize: normalizedSize, treeCollapsed }
      : tab,
  );
}

export function updateTerminalTitle(
  layout: WorkbenchLayout,
  tabId: string,
  title: string,
): WorkbenchLayout {
  const normalized = title.trim();
  if (!normalized) return layout;
  return updateTab(layout, tabId, (tab) =>
    tab.type === "terminal" ? { ...tab, title: normalized.slice(0, 100) } : tab,
  );
}

export function updateBrowserUrl(
  layout: WorkbenchLayout,
  tabId: string,
  url: string,
): WorkbenchLayout {
  return updateTab(layout, tabId, (tab) =>
    tab.type === "browser" && tab.url !== url ? { ...tab, url } : tab,
  );
}

export function closeWorkbenchTab(layout: WorkbenchLayout, tabId: string): WorkbenchLayout {
  const currentPane = layout.workspacePane;
  const index = currentPane.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return layout;
  const tabs = currentPane.tabs.filter((tab) => tab.id !== tabId);
  const activeTabId =
    currentPane.activeTabId === tabId
      ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
      : currentPane.activeTabId === null
        ? null
        : tabs.some((tab) => tab.id === currentPane.activeTabId)
          ? currentPane.activeTabId
          : (tabs[0]?.id ?? null);
  return { ...layout, workspacePane: { ...currentPane, tabs, activeTabId } };
}

export function reorderWorkbenchTab(
  layout: WorkbenchLayout,
  sourceId: string,
  targetId: string,
): WorkbenchLayout {
  const sourceIndex = layout.workspacePane.tabs.findIndex((tab) => tab.id === sourceId);
  const targetIndex = layout.workspacePane.tabs.findIndex((tab) => tab.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return layout;
  const tabs = [...layout.workspacePane.tabs];
  const [source] = tabs.splice(sourceIndex, 1);
  if (!source) return layout;
  tabs.splice(targetIndex, 0, source);
  return { ...layout, workspacePane: { ...layout.workspacePane, tabs } };
}

export function remapExplorerFiles(
  layout: WorkbenchLayout,
  from: string,
  to: string,
  directory: boolean,
): WorkbenchLayout {
  const normalizedFrom = normalizePath(from);
  const normalizedTo = normalizePath(to);
  return {
    ...layout,
    workspacePane: {
      ...layout.workspacePane,
      tabs: layout.workspacePane.tabs.map((tab) =>
        tab.type === "explorer" && tab.activeFilePath
          ? {
              ...tab,
              activeFilePath: remapMovedPath(
                tab.activeFilePath,
                normalizedFrom,
                normalizedTo,
                directory,
              ),
            }
          : tab,
      ),
    },
  };
}

export function removeExplorerFiles(
  layout: WorkbenchLayout,
  path: string,
  directory: boolean,
  retainedSelection?: Readonly<{ explorerId: string; path: string }>,
): WorkbenchLayout {
  const normalized = normalizePath(path);
  const retainedPath = retainedSelection ? normalizePath(retainedSelection.path) : null;
  return {
    ...layout,
    workspacePane: {
      ...layout.workspacePane,
      tabs: layout.workspacePane.tabs.map((tab) =>
        tab.type === "explorer" &&
        tab.activeFilePath &&
        (tab.activeFilePath === normalized ||
          (directory && tab.activeFilePath.startsWith(`${normalized}/`)))
          ? retainedSelection &&
            tab.id === retainedSelection.explorerId &&
            tab.activeFilePath === retainedPath
            ? tab
            : { ...tab, activeFilePath: null }
          : tab,
      ),
    },
  };
}

export function workbenchTabLabel(tab: WorkbenchTab): string {
  switch (tab.type) {
    case "diff":
      return "文件变动";
    case "explorer":
      return tab.activeFilePath ? baseName(tab.activeFilePath) : "资源管理器";
    case "terminal":
      return tab.title;
    case "browser": {
      if (!tab.url) return "浏览器";
      try {
        return new URL(tab.url).hostname || "浏览器";
      } catch {
        return "浏览器";
      }
    }
  }
}

function appendTab(layout: WorkbenchLayout, tab: WorkbenchTab): WorkbenchLayout {
  if (layout.workspacePane.tabs.length >= MAX_WORKBENCH_TABS) return layout;
  return {
    ...layout,
    workspacePane: {
      ...layout.workspacePane,
      tabs: [...layout.workspacePane.tabs, tab],
      activeTabId: tab.id,
    },
  };
}

function updateTab(
  layout: WorkbenchLayout,
  tabId: string,
  update: (tab: WorkbenchTab) => WorkbenchTab,
): WorkbenchLayout {
  const index = layout.workspacePane.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return layout;
  const tabs = [...layout.workspacePane.tabs];
  const current = tabs[index]!;
  const next = update(current);
  if (next === current) return layout;
  tabs[index] = next;
  return { ...layout, workspacePane: { ...layout.workspacePane, tabs } };
}
