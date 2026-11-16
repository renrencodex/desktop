import type { ApiClient } from "@cloud-machine/api-client";
import type { WorkspaceApiConfig } from "@cloud-machine/workspace-ui";

import { getClientHost } from "../host";

/**
 * 保留原有组件的单例调用形状，但每次访问都转发到当前宿主注入的客户端。
 * Desktop UI 因此不依赖 Next 的同源代理，也不会意外使用 Cookie 会话。
 */
export const api: ApiClient = new Proxy({} as ApiClient, {
  get(_target, property) {
    return Reflect.get(getClientHost().api, property);
  },
});

export const workspaceApiConfig: WorkspaceApiConfig = {
  get baseUrl() {
    return getClientHost().apiBaseUrl;
  },
  client: api,
};
