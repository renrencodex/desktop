import { parseWorkspaceRoute } from "./workspace-routes";

export interface WorkspaceLocation {
  key: string;
  machineId: string;
  workspaceId: string;
  pathname: string;
  search: string;
}

export interface WorkspaceProtection {
  dirty: number;
  busy: boolean;
  unsynced?: boolean;
}

/** Web/Desktop 主壳共享的最小状态模型；渲染和状态容器由宿主选择。 */
export interface WorkspaceShellModel {
  readonly entries: readonly WorkspaceLocation[];
  readonly connected: ReadonlySet<string>;
  readonly current: WorkspaceLocation | null;
  readonly resources: Readonly<Record<string, WorkspaceProtection>>;
  readonly hasUnsaved: boolean;
}

export const MAX_RETAINED_WORKSPACES = 10;
export const MAX_CONNECTED_WORKSPACES = 10;

/** 解析主壳可常驻的 Workspace 地址，并移除一次性 session 参数。 */
export function workspaceLocation(pathname: string, search = ""): WorkspaceLocation | null {
  const route = parseWorkspaceRoute(pathname);
  if (!route) return null;
  const params = new URLSearchParams(search);
  params.delete("session");
  return {
    key: `${route.machineId}:${route.workspaceId}`,
    machineId: route.machineId,
    workspaceId: route.workspaceId,
    pathname,
    search: params.toString(),
  };
}

/** Connection budget is independent of dirty-file protection and route effect timing. */
export function connectedWorkspaceKeys(
  entries: readonly { key: string }[],
  active: string | undefined,
): Set<string> {
  const recent = [...new Set(entries.map((entry) => entry.key))].filter((key) => key !== active);
  if (active) recent.push(active);
  return new Set(recent.slice(-MAX_CONNECTED_WORKSPACES));
}

export function protectedWorkspace(value: WorkspaceProtection | undefined): boolean {
  return !value || value.dirty > 0 || value.busy || value.unsynced === true;
}

/** Oldest first. Unregistered/loading workspaces are protected too. */
export function trimWorkspaces<T extends { key: string }>(
  entries: T[],
  active: string | undefined,
  resources: Record<string, WorkspaceProtection>,
  limit = MAX_RETAINED_WORKSPACES,
): T[] {
  let remaining = entries.length;
  return entries.filter((entry) => {
    if (remaining <= limit || entry.key === active || protectedWorkspace(resources[entry.key]))
      return true;
    remaining--;
    return false;
  });
}
