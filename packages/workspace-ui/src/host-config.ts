import type { ApiClient } from "@cloud-machine/api-client";
import type { PlatformApi } from "@cloud-machine/platform-api";

/** Workspace 壳需要的宿主导航能力；具体路由器由 Web/Desktop 注入。 */
export interface HostNavigation {
  push(href: string): void;
  replace(href: string): void;
  prefetch(href: string): void;
}

export type WorkspacePlatformKind = "web" | "tauri-desktop" | "tauri-mobile";

/** 平台能力与运行时种类保持显式，Workspace UI 不直接探测宿主。 */
export interface WorkspacePlatformConfig {
  readonly kind: WorkspacePlatformKind;
  readonly api: PlatformApi;
}

/** API 客户端及其公开基址由宿主统一配置。 */
export interface WorkspaceApiConfig {
  readonly baseUrl: string;
  readonly client: ApiClient;
}

export interface WorkspaceHostConfig {
  readonly navigation: HostNavigation;
  readonly platform: WorkspacePlatformConfig;
  readonly api: WorkspaceApiConfig;
}
