import { describe, expect, test } from "bun:test";

import { hasCapability, PlatformCapabilityUnsupportedError, type PlatformApi } from "./index";
import { createTauriPlatformApi } from "./tauri";
import { createWebPlatformApi } from "./web";

async function expectUnsupported(api: PlatformApi, capability: "secure-storage" | "notification") {
  expect(hasCapability(api, capability)).toBe(false);
  if (capability === "secure-storage") {
    await expect(api.secureStorage.get("k")).rejects.toBeInstanceOf(
      PlatformCapabilityUnsupportedError,
    );
  } else {
    await expect(api.notify({ title: "t" })).rejects.toBeInstanceOf(
      PlatformCapabilityUnsupportedError,
    );
  }
}

describe("createWebPlatformApi", () => {
  test("声明浏览器可用能力并使用注入的链接与剪贴板实现", async () => {
    const opened: string[] = [];
    const copied: string[] = [];
    const api = createWebPlatformApi({
      openUrl: (url) => opened.push(url),
      writeClipboardText: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });

    expect(hasCapability(api, "external-browser")).toBe(true);
    expect(hasCapability(api, "clipboard-write")).toBe(true);
    expect(hasCapability(api, "download-directory")).toBe(false);
    expect(hasCapability(api, "file-save")).toBe(false);
    await api.clipboard.writeText("https://example.com/device");
    await api.openExternal("https://example.com");
    await api.openPreview("https://preview.example.com");
    expect(opened).toEqual(["https://example.com", "https://preview.example.com"]);
    expect(copied).toEqual(["https://example.com/device"]);
    await expectUnsupported(api, "secure-storage");
    await expectUnsupported(api, "notification");
    expect(hasCapability(api, "isolated-preview")).toBe(false);
    expect(hasCapability(api, "app-update")).toBe(false);
    await expect(
      api.isolatedPreview.open({
        id: "tab_1",
        url: "https://80-machine.preview.renrencodex.com",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      }),
    ).rejects.toBeInstanceOf(PlatformCapabilityUnsupportedError);
    await expect(api.appUpdate.check()).rejects.toBeInstanceOf(PlatformCapabilityUnsupportedError);
    await expect(api.downloads.openDirectory()).rejects.toBeInstanceOf(
      PlatformCapabilityUnsupportedError,
    );
    await expect(
      api.downloads.createFile("file.bin", "application/octet-stream"),
    ).rejects.toBeInstanceOf(PlatformCapabilityUnsupportedError);
    // Web 端没有 deep link，订阅返回可安全调用的退订函数。
    expect(api.onDeepLink(() => {})).toBeInstanceOf(Function);
  });
});

describe("createTauriPlatformApi", () => {
  test("声明原生能力并把受控调用映射到命令", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const api = createTauriPlatformApi({
      invoke: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve(null as never);
      },
      listen: () => Promise.resolve(() => {}),
      createChannel: (onMessage) => ({ onMessage }),
    });

    expect(hasCapability(api, "external-browser")).toBe(true);
    expect(hasCapability(api, "secure-storage")).toBe(true);
    expect(hasCapability(api, "deep-link")).toBe(true);
    expect(hasCapability(api, "isolated-preview")).toBe(true);
    expect(hasCapability(api, "clipboard-write")).toBe(true);
    expect(hasCapability(api, "download-directory")).toBe(true);
    expect(hasCapability(api, "file-save")).toBe(false);
    expect(hasCapability(api, "app-update")).toBe(true);
    await api.clipboard.writeText("https://example.com/device");
    await api.downloads.openDirectory();
    await api.secureStorage.get("desktop-refresh-token");
    await api.secureStorage.set("desktop-refresh-token", "refresh-secret");
    await api.secureStorage.remove("desktop-refresh-token");
    await api.openExternal("https://example.com");
    await api.openPreview("https://preview.example.com");
    await api.isolatedPreview.open({
      id: "tab_1",
      url: "https://80-machine.preview.renrencodex.com?token=secret",
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    });
    await api.isolatedPreview.setBounds({
      id: "tab_1",
      bounds: { x: 20, y: 30, width: 700, height: 500 },
    });
    await api.isolatedPreview.setVisible({ id: "tab_1", visible: false });
    await api.isolatedPreview.capture({ id: "tab_1" });
    await api.isolatedPreview.close({ id: "tab_1" });
    await api.appUpdate.currentVersion();
    await api.appUpdate.check();
    const progress: unknown[] = [];
    await api.appUpdate.install((event) => progress.push(event));
    expect(calls).toEqual([
      {
        command: "clipboard_write",
        args: { request: { text: "https://example.com/device" } },
      },
      { command: "open_download_directory", args: undefined },
      {
        command: "secure_storage_get",
        args: { key: "desktop-refresh-token" },
      },
      {
        command: "secure_storage_set",
        args: { key: "desktop-refresh-token", value: "refresh-secret" },
      },
      {
        command: "secure_storage_remove",
        args: { key: "desktop-refresh-token" },
      },
      { command: "open_external", args: { url: "https://example.com" } },
      { command: "open_external", args: { url: "https://preview.example.com" } },
      {
        command: "preview_webview_open",
        args: {
          request: {
            id: "tab_1",
            url: "https://80-machine.preview.renrencodex.com?token=secret",
            bounds: { x: 10, y: 20, width: 800, height: 600 },
          },
        },
      },
      {
        command: "preview_webview_set_bounds",
        args: {
          request: {
            id: "tab_1",
            bounds: { x: 20, y: 30, width: 700, height: 500 },
          },
        },
      },
      {
        command: "preview_webview_set_visible",
        args: { request: { id: "tab_1", visible: false } },
      },
      { command: "preview_webview_capture", args: { request: { id: "tab_1" } } },
      { command: "preview_webview_close", args: { request: { id: "tab_1" } } },
      { command: "desktop_update_current_version", args: undefined },
      { command: "desktop_update_check", args: undefined },
      {
        command: "desktop_update_install",
        args: { onEvent: { onMessage: expect.any(Function) } },
      },
    ]);
    await expectUnsupported(api, "notification");
  });

  test("invoke 拒绝时向上传递错误", async () => {
    const api = createTauriPlatformApi({
      invoke: () => Promise.reject(new Error("capability denied")),
      listen: () => Promise.resolve(() => {}),
      createChannel: (onMessage) => ({ onMessage }),
    });
    await expect(api.openExternal("https://example.com")).rejects.toThrow("capability denied");
  });

  test("可以为非 Windows 构建关闭更新能力", async () => {
    const api = createTauriPlatformApi({
      invoke: () => Promise.resolve(null as never),
      listen: () => Promise.resolve(() => {}),
      createChannel: (onMessage) => ({ onMessage }),
      appUpdateEnabled: false,
    });

    expect(hasCapability(api, "app-update")).toBe(false);
    await expect(api.appUpdate.check()).rejects.toBeInstanceOf(PlatformCapabilityUnsupportedError);
  });

  test("Android 使用系统文件选择器并按确认位置分块写入", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const api = createTauriPlatformApi({
      kind: "mobile",
      invoke: (command, args) => {
        calls.push({ command, args });
        if (command === "mobile_download_create") {
          return Promise.resolve({ id: "writer-1", position: 0 } as never);
        }
        if (command === "mobile_download_write") {
          return Promise.resolve({ position: 3 } as never);
        }
        if (command === "mobile_download_reset") {
          return Promise.resolve({ position: 0 } as never);
        }
        return Promise.resolve(undefined as never);
      },
      listen: () => Promise.resolve(() => {}),
      createChannel: (onMessage) => ({ onMessage }),
    });

    expect(hasCapability(api, "file-save")).toBe(true);
    expect(hasCapability(api, "download-directory")).toBe(false);
    expect(hasCapability(api, "isolated-preview")).toBe(false);
    const writer = await api.downloads.createFile("archive.zip", "application/zip");
    await writer.write(new Uint8Array([1, 2, 3]));
    expect(writer.position).toBe(3);
    await writer.reset();
    expect(writer.position).toBe(0);
    await writer.complete();

    expect(calls).toEqual([
      {
        command: "mobile_download_create",
        args: { request: { fileName: "archive.zip", mimeType: "application/zip" } },
      },
      {
        command: "mobile_download_write",
        args: { request: { id: "writer-1", data: "AQID" } },
      },
      {
        command: "mobile_download_reset",
        args: { request: { id: "writer-1" } },
      },
      {
        command: "mobile_download_complete",
        args: { request: { id: "writer-1" } },
      },
    ]);
    await expect(writer.write(new Uint8Array([4]))).rejects.toThrow("closed");
  });

  test("Android 完成保存失败后仍可清理系统目标", async () => {
    const calls: string[] = [];
    const api = createTauriPlatformApi({
      kind: "mobile",
      invoke: (command) => {
        calls.push(command);
        if (command === "mobile_download_create") {
          return Promise.resolve({ id: "writer-1", position: 0 } as never);
        }
        if (command === "mobile_download_complete") {
          return Promise.reject(new Error("flush failed"));
        }
        return Promise.resolve(undefined as never);
      },
      listen: () => Promise.resolve(() => {}),
      createChannel: (onMessage) => ({ onMessage }),
    });

    const writer = await api.downloads.createFile("archive.zip", "application/zip");
    await expect(writer.complete()).rejects.toThrow("flush failed");
    await writer.discard();
    expect(calls).toEqual([
      "mobile_download_create",
      "mobile_download_complete",
      "mobile_download_discard",
    ]);
  });

  test("deep link 监听事件并补取启动回调", async () => {
    const received: string[] = [];
    let eventHandler: ((event: { payload: { url: string } }) => void) | undefined;
    const api = createTauriPlatformApi({
      invoke: (command) => {
        expect(command).toBe("take_pending_deep_link");
        return Promise.resolve({
          url: "renrencodex://oauth/callback?code=start&state=state",
        } as never);
      },
      listen: (_event, handler) => {
        eventHandler = handler as typeof eventHandler;
        return Promise.resolve(() => {});
      },
      createChannel: (onMessage) => ({ onMessage }),
    });

    const unsubscribe = api.onDeepLink((url) => received.push(url));
    expect(unsubscribe).toBeInstanceOf(Function);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual(["renrencodex://oauth/callback?code=start&state=state"]);

    eventHandler?.({
      payload: {
        url: "renrencodex://oauth/callback?code=next&state=state",
      },
    });
    expect(received.at(-1)).toBe("renrencodex://oauth/callback?code=next&state=state");
  });

  test("Android deep link 交付后精确确认，不留作下次启动回放", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    let eventHandler: ((event: { payload: { url: string } }) => void) | undefined;
    const api = createTauriPlatformApi({
      kind: "mobile",
      invoke: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve(null as never);
      },
      listen: (_event, handler) => {
        eventHandler = handler as typeof eventHandler;
        return Promise.resolve(() => {});
      },
      createChannel: (onMessage) => ({ onMessage }),
    });

    api.onDeepLink(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const url = "https://renrencodex.com/register?invite=abc";
    eventHandler?.({ payload: { url } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([
      { command: "take_pending_deep_link", args: undefined },
      {
        command: "acknowledge_deep_link",
        args: { payload: { url } },
      },
    ]);
  });

  test("异步 listener 就绪前退订也会清理底层监听", async () => {
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    let stopped = 0;
    let invoked = false;
    const api = createTauriPlatformApi({
      invoke: () => {
        invoked = true;
        return Promise.resolve(null as never);
      },
      listen: () =>
        new Promise((resolve) => {
          resolveListen = resolve;
        }),
      createChannel: (onMessage) => ({ onMessage }),
    });

    const unsubscribe = api.onDeepLink(() => {});
    unsubscribe();
    resolveListen?.(() => {
      stopped += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stopped).toBe(1);
    expect(invoked).toBe(false);
  });
});
