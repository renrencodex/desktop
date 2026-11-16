import {
  DEFAULT_APPLICATION_PANE,
  type ApplicationPane,
  type CliAppId,
} from "@cloud-machine/client-contracts";
import type { WorkbenchLayout } from "@cloud-machine/api-client";

export function openCliApplication(
  pane: ApplicationPane | undefined,
  appId: CliAppId,
  fresh = false,
): ApplicationPane {
  const current = pane ?? DEFAULT_APPLICATION_PANE;
  const existing = [...current.instances]
    .reverse()
    .find((item) => item.appId === appId && item.mode === "run");
  if (!fresh && existing)
    return {
      ...current,
      collapsed: false,
      compactView: "applications",
      activeInstanceId: existing.id,
    };
  if (current.instances.length >= 16) return current;
  const instance = { id: `app_${crypto.randomUUID()}`, appId, mode: "run" as const };
  return {
    ...current,
    collapsed: false,
    compactView: "applications",
    instances: [...current.instances, instance],
    activeInstanceId: instance.id,
  };
}

export function closeCliApplication(pane: ApplicationPane, id: string): ApplicationPane {
  const index = pane.instances.findIndex((item) => item.id === id);
  if (index < 0) return pane;
  const instances = pane.instances.filter((item) => item.id !== id);
  const activeInstanceId =
    pane.activeInstanceId === id
      ? (instances[Math.min(index, instances.length - 1)]?.id ?? null)
      : pane.activeInstanceId;
  return {
    ...pane,
    instances,
    collapsed: instances.length === 0 ? true : pane.collapsed,
    activeInstanceId,
  };
}

export function updateWorkbenchApplicationPane(
  layout: WorkbenchLayout,
  update: ApplicationPane | ((current: ApplicationPane) => ApplicationPane),
): WorkbenchLayout {
  const currentPane = layout.applicationPane ?? DEFAULT_APPLICATION_PANE;
  const applicationPane = typeof update === "function" ? update(currentPane) : update;
  const closedLastInstance =
    currentPane.instances.length > 0 && applicationPane.instances.length === 0;
  return {
    ...layout,
    version: 12,
    applicationPane,
    workspacePane:
      closedLastInstance && layout.workspacePane.activeTabId !== null
        ? { ...layout.workspacePane, activeTabId: null }
        : layout.workspacePane,
  };
}

/** Remote removal wins over stale activations; independent instance additions survive. */
export function rebaseApplicationPane(
  base?: ApplicationPane,
  local?: ApplicationPane,
  remote?: ApplicationPane,
): ApplicationPane {
  const b = base ?? DEFAULT_APPLICATION_PANE;
  const l = local ?? DEFAULT_APPLICATION_PANE;
  const r = remote ?? DEFAULT_APPLICATION_PANE;
  const baseIds = new Set(b.instances.map((item) => item.id));
  const localIds = new Set(l.instances.map((item) => item.id));
  const instances = r.instances.filter((item) => !baseIds.has(item.id) || localIds.has(item.id));
  const ids = new Set(instances.map((item) => item.id));
  for (const item of l.instances)
    if (!baseIds.has(item.id) && !ids.has(item.id)) {
      instances.push(item);
      ids.add(item.id);
    }
  // Concurrent additions must not exceed the server instance limit.
  instances.splice(16);
  const retainedIds = new Set(instances.map((item) => item.id));
  const requested =
    b.activeInstanceId === l.activeInstanceId ? r.activeInstanceId : l.activeInstanceId;
  return {
    collapsed: b.collapsed === l.collapsed ? r.collapsed : l.collapsed,
    compactView: b.compactView === l.compactView ? r.compactView : l.compactView,
    size: b.size === l.size ? r.size : l.size,
    instances,
    activeInstanceId: requested !== null && retainedIds.has(requested) ? requested : null,
  };
}
