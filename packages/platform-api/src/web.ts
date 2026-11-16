import type { PlatformCapability } from "@cloud-machine/client-core";

import { unsupportedCapability, type PlatformApi } from "./index";

export interface WebPlatformDeps {
  /** 默认 window.open；测试或受控环境可注入。 */
  openUrl?: (url: string) => void;
  /** 默认 navigator.clipboard.writeText；测试或受控环境可注入。 */
  writeClipboardText?: (text: string) => Promise<void>;
}

interface WindowLike {
  open(url: string, target: string, features: string): void;
}

interface NavigatorLike {
  clipboard?: { writeText(text: string): Promise<void> };
}

/**
 * Web 端能力实现：外部链接经新标签页打开；refresh token 由 HttpOnly Cookie
 * 承担，Web 没有 secure-storage / deep-link / notification 能力。
 */
export function createWebPlatformApi(deps: WebPlatformDeps = {}): PlatformApi {
  const openUrl =
    deps.openUrl ??
    ((url: string) => {
      // 包按平台无关编译（无 DOM lib），经 globalThis 取值，SSR 下安全降级。
      (globalThis as { window?: WindowLike }).window?.open(url, "_blank", "noopener,noreferrer");
    });
  const writeClipboardText =
    deps.writeClipboardText ??
    ((text: string) => {
      const clipboard = (globalThis as { navigator?: NavigatorLike }).navigator?.clipboard;
      return clipboard
        ? clipboard.writeText(text)
        : Promise.reject(new Error("browser clipboard is unavailable"));
    });
  return {
    capabilities: new Set<PlatformCapability>(["external-browser", "clipboard-write"]),
    clipboard: { writeText: writeClipboardText },
    downloads: {
      openDirectory: unsupportedCapability("download-directory"),
      createFile: unsupportedCapability("file-save"),
    },
    secureStorage: {
      get: unsupportedCapability("secure-storage"),
      set: unsupportedCapability("secure-storage"),
      remove: unsupportedCapability("secure-storage"),
    },
    openExternal: (url) => {
      openUrl(url);
      return Promise.resolve();
    },
    // Web 端没有原生子 WebView，端口预览使用新的浏览器标签页。
    openPreview: (url) => {
      openUrl(url);
      return Promise.resolve();
    },
    isolatedPreview: {
      capture: unsupportedCapability("isolated-preview"),
      open: unsupportedCapability("isolated-preview"),
      setBounds: unsupportedCapability("isolated-preview"),
      setVisible: unsupportedCapability("isolated-preview"),
      close: unsupportedCapability("isolated-preview"),
    },
    notify: unsupportedCapability("notification"),
    appUpdate: {
      currentVersion: unsupportedCapability("app-update"),
      check: unsupportedCapability("app-update"),
      install: () => unsupportedCapability("app-update")(),
    },
    onDeepLink: () => () => {},
  };
}
