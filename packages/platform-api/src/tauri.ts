import type { PlatformCapability } from "@cloud-machine/client-core";

import type {
  DeepLinkPayload,
  DesktopUpdateInfo,
  DesktopUpdateProgress,
  MobileDownloadCreateRequest,
  MobileDownloadWriteRequest,
  MobileDownloadWriteResponse,
  MobileDownloadWriterRequest,
  MobileDownloadWriterResponse,
  SecureStorageKey,
} from "./generated/client-protocol";
import { unsupportedCapability, type PlatformApi } from "./index";

/** @tauri-apps/api/core 的 invoke 签名；注入以避免本包直接依赖 Tauri 运行时。 */
export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface TauriEvent<T> {
  payload: T;
}

export type TauriUnlisten = () => void;
export type TauriListen = <T>(
  event: string,
  handler: (event: TauriEvent<T>) => void,
) => Promise<TauriUnlisten>;

export interface TauriPlatformDependencies {
  invoke: TauriInvoke;
  listen: TauriListen;
  createChannel<T>(onMessage: (message: T) => void): unknown;
  appUpdateEnabled?: boolean;
  kind?: "desktop" | "mobile";
}

const DEEP_LINK_EVENTS = {
  desktop: "desktop-deep-link",
  mobile: "mobile-deep-link",
} as const;

/**
 * Tauri 桌面/移动端能力实现：外部链接、剪贴板写入、长期凭据与 deep link
 * 只经 client-native 的受限命令/事件。
 */
export function createTauriPlatformApi({
  invoke,
  listen,
  createChannel,
  appUpdateEnabled = true,
  kind = "desktop",
}: TauriPlatformDependencies): PlatformApi {
  const capabilities = new Set<PlatformCapability>([
    "secure-storage",
    "deep-link",
    "external-browser",
    "clipboard-write",
  ]);
  if (kind === "desktop") {
    capabilities.add("download-directory");
    capabilities.add("isolated-preview");
    if (appUpdateEnabled) capabilities.add("app-update");
  }
  if (kind === "mobile") capabilities.add("file-save");
  return {
    capabilities,
    clipboard: {
      writeText: async (text) => {
        await invoke<void>("clipboard_write", { request: { text } });
      },
    },
    downloads: {
      openDirectory:
        kind === "desktop"
          ? async () => {
              await invoke<void>("open_download_directory");
            }
          : unsupportedCapability("download-directory"),
      createFile:
        kind === "mobile"
          ? async (fileName, mimeType) => {
              const createRequest: MobileDownloadCreateRequest = { fileName, mimeType };
              const created = await invoke<MobileDownloadWriterResponse>("mobile_download_create", {
                request: createRequest,
              });
              let position = created.position;
              let closed = false;
              return {
                get position() {
                  return position;
                },
                async write(chunk) {
                  if (closed) throw new Error("native download writer is closed");
                  const request: MobileDownloadWriteRequest = {
                    id: created.id,
                    data: bytesToBase64(chunk),
                  };
                  const result = await invoke<MobileDownloadWriteResponse>(
                    "mobile_download_write",
                    {
                      request,
                    },
                  );
                  if (result.position !== position + chunk.byteLength) {
                    throw new Error("native download position mismatch");
                  }
                  position = result.position;
                },
                async complete() {
                  if (closed) throw new Error("native download writer is closed");
                  const request: MobileDownloadWriterRequest = { id: created.id };
                  await invoke<void>("mobile_download_complete", {
                    request,
                  });
                  closed = true;
                },
                async reset() {
                  if (closed) throw new Error("native download writer is closed");
                  const request: MobileDownloadWriterRequest = { id: created.id };
                  const result = await invoke<MobileDownloadWriteResponse>(
                    "mobile_download_reset",
                    { request },
                  );
                  if (result.position !== 0) {
                    throw new Error("native download reset position mismatch");
                  }
                  position = 0;
                },
                async discard() {
                  if (closed) return;
                  const request: MobileDownloadWriterRequest = { id: created.id };
                  try {
                    await invoke<void>("mobile_download_discard", {
                      request,
                    });
                  } finally {
                    closed = true;
                  }
                },
              };
            }
          : unsupportedCapability("file-save"),
    },
    secureStorage: {
      get: (key) =>
        invoke<string | null>("secure_storage_get", {
          key: key as SecureStorageKey,
        }),
      set: async (key, value) => {
        await invoke<void>("secure_storage_set", {
          key: key as SecureStorageKey,
          value,
        });
      },
      remove: async (key) => {
        await invoke<void>("secure_storage_remove", {
          key: key as SecureStorageKey,
        });
      },
    },
    openExternal: async (url) => {
      await invoke("open_external", { url });
    },
    // Ports 面板没有内嵌容器，仍交给系统浏览器；工作台使用 isolatedPreview。
    openPreview: async (url) => {
      await invoke("open_external", { url });
    },
    isolatedPreview:
      kind === "desktop"
        ? {
            capture: (request) => invoke("preview_webview_capture", { request }),
            open: async (request) => {
              await invoke("preview_webview_open", { request });
            },
            setBounds: async (request) => {
              await invoke("preview_webview_set_bounds", { request });
            },
            setVisible: async (request) => {
              await invoke("preview_webview_set_visible", { request });
            },
            close: async (request) => {
              await invoke("preview_webview_close", { request });
            },
          }
        : {
            capture: unsupportedCapability("isolated-preview"),
            open: unsupportedCapability("isolated-preview"),
            setBounds: unsupportedCapability("isolated-preview"),
            setVisible: unsupportedCapability("isolated-preview"),
            close: unsupportedCapability("isolated-preview"),
          },
    notify: unsupportedCapability("notification"),
    appUpdate:
      kind === "desktop" && appUpdateEnabled
        ? {
            currentVersion: () => invoke<string>("desktop_update_current_version"),
            check: () => invoke<DesktopUpdateInfo | null>("desktop_update_check"),
            install: async (onProgress) => {
              await invoke<void>("desktop_update_install", {
                onEvent: createChannel<DesktopUpdateProgress>(onProgress),
              });
            },
          }
        : {
            currentVersion: unsupportedCapability("app-update"),
            check: unsupportedCapability("app-update"),
            install: () => unsupportedCapability("app-update")(),
          },
    onDeepLink: (listener) => {
      let active = true;
      let unlisten: TauriUnlisten | undefined;
      let initializing = true;
      const deliveredWhileInitializing = new Set<string>();

      void listen<DeepLinkPayload>(DEEP_LINK_EVENTS[kind], ({ payload }) => {
        if (!active) return;
        if (initializing) deliveredWhileInitializing.add(payload.url);
        try {
          listener(payload.url);
        } finally {
          if (kind === "mobile") {
            void invoke<void>("acknowledge_deep_link", { payload }).catch(() => {
              // Pending 仍保留在 Native；下次 renderer 初始化时可以重新交付。
            });
          }
        }
      })
        .then(async (stopListening) => {
          if (!active) {
            stopListening();
            return;
          }
          unlisten = stopListening;
          const pending = await invoke<DeepLinkPayload | null>("take_pending_deep_link");
          if (active && pending !== null && !deliveredWhileInitializing.has(pending.url)) {
            listener(pending.url);
          }
        })
        .catch(() => {
          // API 必须同步返回 unsubscribe；异步注册失败不能形成未处理 rejection。
        })
        .finally(() => {
          initializing = false;
          deliveredWhileInitializing.clear();
        });

      return () => {
        active = false;
        unlisten?.();
      };
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  const segments: string[] = [];
  const segmentSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += segmentSize) {
    segments.push(String.fromCharCode(...bytes.subarray(offset, offset + segmentSize)));
  }
  return btoa(segments.join(""));
}
