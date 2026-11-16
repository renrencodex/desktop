import type { TerminalLayoutNode, WorkbenchLayout, WorkbenchTab } from "@cloud-machine/api-client";
import { rebaseApplicationPane } from "@cloud-machine/workspace-ui";

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedValue<T>(base: T, local: T, remote: T): T {
  return sameValue(base, local) ? remote : local;
}

function terminalPaneIds(node: TerminalLayoutNode): string[] {
  return node.type === "terminal-pane"
    ? [node.paneId]
    : [...terminalPaneIds(node.first), ...terminalPaneIds(node.second)];
}

function mergeExistingTab(
  base: WorkbenchTab,
  local: WorkbenchTab,
  remote: WorkbenchTab,
): WorkbenchTab {
  if (base.type !== local.type || base.type !== remote.type) return remote;
  if (base.type === "diff" || local.type === "diff" || remote.type === "diff") return remote;
  if (base.type === "explorer" && local.type === "explorer" && remote.type === "explorer") {
    return {
      ...remote,
      activeFilePath: changedValue(
        base.activeFilePath,
        local.activeFilePath,
        remote.activeFilePath,
      ),
      treeSize: changedValue(base.treeSize, local.treeSize, remote.treeSize),
      treeCollapsed: changedValue(base.treeCollapsed, local.treeCollapsed, remote.treeCollapsed),
    };
  }
  if (base.type === "browser" && local.type === "browser" && remote.type === "browser") {
    return { ...remote, url: changedValue(base.url, local.url, remote.url) };
  }
  if (base.type === "terminal" && local.type === "terminal" && remote.type === "terminal") {
    const root = changedValue(base.root, local.root, remote.root);
    const panes = terminalPaneIds(root);
    const requestedActivePaneId = changedValue(
      base.activePaneId,
      local.activePaneId,
      remote.activePaneId,
    );
    return {
      ...remote,
      title: changedValue(base.title, local.title, remote.title),
      root,
      activePaneId: panes.includes(requestedActivePaneId)
        ? requestedActivePaneId
        : panes.includes(remote.activePaneId)
          ? remote.activePaneId
          : panes[0]!,
    };
  }
  return remote;
}

/**
 * Replays the changes between base and local onto a newer remote layout.
 * Remote tab deletion wins over stale local edits, while independent additions and field edits survive.
 */
export function rebaseWorkbenchLayout(
  base: WorkbenchLayout,
  local: WorkbenchLayout,
  remote: WorkbenchLayout,
): WorkbenchLayout {
  const baseTabs = new Map(base.workspacePane.tabs.map((tab) => [tab.id, tab]));
  const localTabs = new Map(local.workspacePane.tabs.map((tab) => [tab.id, tab]));
  const mergedTabs = new Map<string, WorkbenchTab>();

  for (const remoteTab of remote.workspacePane.tabs) {
    const baseTab = baseTabs.get(remoteTab.id);
    const localTab = localTabs.get(remoteTab.id);
    if (baseTab && !localTab) continue;
    mergedTabs.set(
      remoteTab.id,
      baseTab && localTab ? mergeExistingTab(baseTab, localTab, remoteTab) : remoteTab,
    );
  }
  for (const localTab of local.workspacePane.tabs) {
    if (!baseTabs.has(localTab.id) && !mergedTabs.has(localTab.id)) {
      mergedTabs.set(localTab.id, localTab);
    }
  }

  const tabs = [
    ...local.workspacePane.tabs.flatMap((tab) => {
      const merged = mergedTabs.get(tab.id);
      return merged ? [merged] : [];
    }),
    ...remote.workspacePane.tabs.filter((tab) => !localTabs.has(tab.id) && mergedTabs.has(tab.id)),
  ];
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const localChangedActive = local.workspacePane.activeTabId !== base.workspacePane.activeTabId;
  const preferredActive = localChangedActive
    ? local.workspacePane.activeTabId
    : remote.workspacePane.activeTabId;
  const activeTabId =
    preferredActive === null
      ? null
      : tabIds.has(preferredActive)
        ? preferredActive
        : remote.workspacePane.activeTabId && tabIds.has(remote.workspacePane.activeTabId)
          ? remote.workspacePane.activeTabId
          : (tabs[0]?.id ?? null);

  return {
    ...remote,
    workspacePane: { tabs, activeTabId },
    ...(base.applicationPane || local.applicationPane || remote.applicationPane
      ? {
          version: 12 as const,
          applicationPane: rebaseApplicationPane(
            base.applicationPane,
            local.applicationPane,
            remote.applicationPane,
          ),
        }
      : {}),
  };
}

export function workbenchLayoutsEqual(left: WorkbenchLayout, right: WorkbenchLayout): boolean {
  return sameValue(left, right);
}
