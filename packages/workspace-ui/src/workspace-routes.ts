export interface WorkspaceRoute {
  machineId: string;
  workspaceId: string;
}

export function buildMachineRoute(machineId: string): string {
  return `/machines/${machineId}`;
}

export function buildWorkspaceRoute(machineId: string, workspaceId: string): string {
  return `${buildMachineRoute(machineId)}/workspaces/${workspaceId}`;
}

/** 只解析可作为 Workspace 主壳入口的规范路由。 */
export function parseWorkspaceRoute(pathname: string): WorkspaceRoute | null {
  const match = /^\/machines\/([^/]+)\/workspaces\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  return { machineId: match[1]!, workspaceId: match[2]! };
}

/** Workspace 页面及其子路由都视为同一个 Workspace 导航范围。 */
export function isWorkspaceRoute(
  pathname: string,
  machineId: string,
  workspaceId: string,
): boolean {
  const workspaceRoute = buildWorkspaceRoute(machineId, workspaceId);
  return pathname === workspaceRoute || pathname.startsWith(`${workspaceRoute}/`);
}

export function workspaceRecoveryTarget(input: {
  machineId: string;
  workspaceId: string;
  machineNotFound: boolean;
  machineFound: boolean;
  workspaceNotFound: boolean;
  workspaceMachineId?: string;
}): string | null {
  if (input.machineNotFound) return "/";
  if (!input.machineFound) return null;
  if (input.workspaceNotFound) return buildMachineRoute(input.machineId);
  if (input.workspaceMachineId && input.workspaceMachineId !== input.machineId) {
    return buildWorkspaceRoute(input.workspaceMachineId, input.workspaceId);
  }
  return null;
}
