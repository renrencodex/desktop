export type { Machine, User, Workspace } from "@cloud-machine/api-client";

export type PlatformCapability =
  | "secure-storage"
  | "deep-link"
  | "notification"
  | "external-browser"
  | "clipboard-write"
  | "download-directory"
  | "file-save"
  | "isolated-preview"
  | "app-update";

export interface WorkspaceScope {
  machineId: string;
  workspaceId: string;
}

export const workspaceQueryKey = (workspaceId: string) => ["workspace", workspaceId] as const;
export const workspaceLayoutQueryKey = (workspaceId: string) =>
  ["workbench-layout", workspaceId] as const;

export {
  buildDesktopAuthorizeUrl,
  createDesktopAuthorizationAttempt,
  parseDesktopAuthorizationCallback,
  type DesktopAuthorizationAttempt,
  type DesktopAuthorizationCallback,
} from "./desktop-auth";
