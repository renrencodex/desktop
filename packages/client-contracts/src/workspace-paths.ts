/** Platform images run machine-agentd and the terminal daemon as root. */
export const DEFAULT_WORKSPACE_ROOT = "/root/workspace";
export const DEFAULT_WORKSPACE_PATH = `${DEFAULT_WORKSPACE_ROOT}/default`;
/** User-facing name for a default Workspace created by the platform. */
export const DEFAULT_WORKSPACE_DISPLAY_NAME = "默认项目";
/** Existing registrations remain usable; never create or migrate this path implicitly. */
export const LEGACY_WORKSPACE_PATH = "/workspace";

/**
 * New projects always use the managed root. Existing projects may remain registered under
 * legacy or user-home paths, but must not influence where subsequent projects are created.
 */
export function workspaceRootForRegistrations(
  _workspaces: readonly { path: string; lifecycleStatus: string }[],
): string {
  void _workspaces;
  return DEFAULT_WORKSPACE_ROOT;
}

/** Resolve the workspace root inside the VM user's home, not the control-plane user's home. */
export function workspacePathForHome(homeDirectory: string): string {
  const home = homeDirectory.replace(/\/+$/, "");
  if (!home.startsWith("/") || home.split("/").some((part) => part === "." || part === ".."))
    throw new Error("workspace home must be an absolute user home directory");
  return `${home}/workspace`;
}
