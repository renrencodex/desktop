import { expect, test } from "bun:test";
import type { WorkbenchLayout } from "@cloud-machine/api-client";
import { applicationPaneSchema, DEFAULT_APPLICATION_PANE } from "@cloud-machine/client-contracts";
import {
  openCliApplication,
  closeCliApplication,
  rebaseApplicationPane,
  updateWorkbenchApplicationPane,
} from "./applications";

test("double-click reuses an instance; explicit new instances get stable independent identities", () => {
  const first = openCliApplication(undefined, "codex");
  expect(first.compactView).toBe("applications");
  const second = openCliApplication(first, "codex", true);
  expect(second.instances).toHaveLength(2);
  expect(second.instances[0]?.id).toBe(first.activeInstanceId!);
  expect(openCliApplication(second, "codex").activeInstanceId).toBe(second.activeInstanceId!);
  expect(second.instances.every((item) => item.mode === "run")).toBe(true);
  const legacy = {
    ...second,
    instances: [
      ...second.instances,
      { id: "app_legacy_login", appId: "codex", mode: "login" as const },
    ],
  };
  expect(applicationPaneSchema.safeParse(legacy).success).toBe(true);
  expect(openCliApplication(legacy, "codex").activeInstanceId).toBe(second.activeInstanceId!);
  const closedActive = closeCliApplication(second, second.activeInstanceId!);
  expect(closedActive.activeInstanceId).toBe(first.activeInstanceId!);
  expect(closedActive.collapsed).toBe(false);
  const closedLast = closeCliApplication(first, first.activeInstanceId!);
  expect(closedLast.activeInstanceId).toBeNull();
  expect(closedLast.collapsed).toBe(true);
  expect(closedLast.compactView).toBe("applications");
  expect(closeCliApplication(first, "missing")).toBe(first);
});

test("rebase preserves independent changes and remote instance removal wins over stale activation", () => {
  const base = openCliApplication(undefined, "codex");
  const local = openCliApplication(base, "opencode", true);
  const remote = openCliApplication(base, "cursor", true);
  const merged = rebaseApplicationPane(
    base,
    { ...local, compactView: "workspace", size: 55 },
    { ...remote, collapsed: true },
  );
  expect(merged.instances).toHaveLength(3);
  expect(merged.size).toBe(55);
  expect(merged.collapsed).toBe(true);
  expect(merged.compactView).toBe("workspace");
  const removed = rebaseApplicationPane(
    base,
    base,
    closeCliApplication(base, base.activeInstanceId!),
  );
  expect(removed.instances).toHaveLength(0);
  expect(removed.activeInstanceId).toBeNull();
});

test("closing the last application activates the fixed applications tab", () => {
  const first = openCliApplication(undefined, "codex");
  const layout: WorkbenchLayout = {
    version: 12,
    applicationPane: first,
    workspacePane: {
      tabs: [
        {
          id: "explorer",
          type: "explorer",
          activeFilePath: null,
          treeSize: 28,
          treeCollapsed: false,
        },
      ],
      activeTabId: "explorer",
    },
  };

  const closedLast = updateWorkbenchApplicationPane(layout, (pane) =>
    closeCliApplication(pane, first.activeInstanceId!),
  );
  expect(closedLast.applicationPane?.instances).toHaveLength(0);
  expect(closedLast.workspacePane.activeTabId).toBeNull();

  const second = openCliApplication(first, "opencode", true);
  const closedOne = updateWorkbenchApplicationPane({ ...layout, applicationPane: second }, (pane) =>
    closeCliApplication(pane, second.activeInstanceId!),
  );
  expect(closedOne.applicationPane?.instances).toHaveLength(1);
  expect(closedOne.workspacePane.activeTabId).toBe("explorer");
});

test("legacy application panes default to the workspace compact view", () => {
  const legacy = {
    collapsed: false,
    size: 40,
    instances: [],
    activeInstanceId: null,
  };
  expect(applicationPaneSchema.parse(legacy)).toEqual(DEFAULT_APPLICATION_PANE);
});

test("invalid profile and instance references are rejected and opening cannot exceed 16 instances", () => {
  let pane = structuredClone(DEFAULT_APPLICATION_PANE);
  for (let i = 0; i < 16; i++) pane = openCliApplication(pane, "codex", true);
  expect(openCliApplication(pane, "codex", true)).toBe(pane);
  let remote = structuredClone(DEFAULT_APPLICATION_PANE);
  for (let i = 0; i < 16; i++) remote = openCliApplication(remote, "cursor", true);
  expect(
    applicationPaneSchema.safeParse(rebaseApplicationPane(DEFAULT_APPLICATION_PANE, pane, remote))
      .success,
  ).toBe(true);
  expect(applicationPaneSchema.safeParse({ ...pane, activeInstanceId: "missing" }).success).toBe(
    false,
  );
  expect(
    applicationPaneSchema.safeParse({ ...pane, instances: [pane.instances[0], pane.instances[0]] })
      .success,
  ).toBe(false);
});
