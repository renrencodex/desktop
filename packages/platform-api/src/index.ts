import type { PlatformCapability } from "@cloud-machine/client-core";
import type {
  PreviewWebviewCaptureRequest,
  PreviewWebviewSnapshot,
  DesktopUpdateInfo,
  DesktopUpdateProgress,
  PreviewWebviewBoundsRequest,
  PreviewWebviewCloseRequest,
  PreviewWebviewOpenRequest,
  PreviewWebviewVisibilityRequest,
} from "./generated/client-protocol";

export type {
  ClipboardWriteRequest,
  PreviewColorScheme,
  PreviewWebviewCaptureRequest,
  PreviewWebviewSnapshot,
  DeepLinkPayload,
  DesktopUpdateInfo,
  DesktopUpdateProgress,
  NativeError,
  NativeErrorCode,
  PreviewWebviewBounds,
  PreviewWebviewBoundsRequest,
  PreviewWebviewCloseRequest,
  PreviewWebviewOpenRequest,
  PreviewWebviewVisibilityRequest,
  SecureStorageGetRequest,
  SecureStorageKey,
  SecureStorageSetRequest,
  MobileDownloadCreateRequest,
  MobileDownloadWriteRequest,
  MobileDownloadWriteResponse,
  MobileDownloadWriterRequest,
  MobileDownloadWriterResponse,
} from "./generated/client-protocol";

export interface PlatformApi {
  readonly capabilities: ReadonlySet<PlatformCapability>;
  clipboard: {
    writeText(text: string): Promise<void>;
  };
  downloads: {
    openDirectory(): Promise<void>;
    createFile(fileName: string, mimeType: string): Promise<NativeFileWriter>;
  };
  secureStorage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  openExternal(url: string): Promise<void>;
  openPreview(url: string): Promise<void>;
  isolatedPreview: {
    capture(input: PreviewWebviewCaptureRequest): Promise<PreviewWebviewSnapshot>;
    open(input: PreviewWebviewOpenRequest): Promise<void>;
    setBounds(input: PreviewWebviewBoundsRequest): Promise<void>;
    setVisible(input: PreviewWebviewVisibilityRequest): Promise<void>;
    close(input: PreviewWebviewCloseRequest): Promise<void>;
  };
  notify(input: { title: string; body?: string }): Promise<void>;
  appUpdate: {
    currentVersion(): Promise<string>;
    check(): Promise<DesktopUpdateInfo | null>;
    install(onProgress: (progress: DesktopUpdateProgress) => void): Promise<void>;
  };
  onDeepLink(listener: (url: string) => void): () => void;
}

/** 由 Native 系统文件选择器创建，按确认顺序分块写入；position 只在写成功后前进。 */
export interface NativeFileWriter {
  readonly position: number;
  write(chunk: Uint8Array): Promise<void>;
  complete(): Promise<void>;
  reset(): Promise<void>;
  discard(): Promise<void>;
}

export function hasCapability(api: PlatformApi, capability: PlatformCapability): boolean {
  return api.capabilities.has(capability);
}

/** 调用未在当前平台落地的能力时抛出；调用方应先经 hasCapability 判断。 */
export class PlatformCapabilityUnsupportedError extends Error {
  constructor(readonly capability: PlatformCapability) {
    super(`platform capability is not available here: ${capability}`);
    this.name = "PlatformCapabilityUnsupportedError";
  }
}

export function unsupportedCapability(capability: PlatformCapability): () => Promise<never> {
  return () => Promise.reject(new PlatformCapabilityUnsupportedError(capability));
}
