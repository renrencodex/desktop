// Generated from crates/client-protocol. Do not edit.

export type OpenExternalRequest = { url: string };

export type ClipboardWriteRequest = { text: string };

export type NotificationRequest = { title: string; body: string | null };

export type SecureStorageKey = "desktop-refresh-token" | "mobile-refresh-token";

export type SecureStorageGetRequest = { key: SecureStorageKey };

export type SecureStorageSetRequest = { key: SecureStorageKey; value: string };

export type DeepLinkPayload = { url: string };

export type MobileDownloadCreateRequest = { fileName: string; mimeType: string };

export type MobileDownloadWriterRequest = { id: string };

export type MobileDownloadWriteRequest = { id: string; data: string };

export type MobileDownloadWriterResponse = { id: string; position: number };

export type MobileDownloadWriteResponse = { position: number };

export type PreviewWebviewBounds = { x: number; y: number; width: number; height: number };

export type PreviewWebviewOpenRequest = { id: string; url: string; bounds: PreviewWebviewBounds };

export type PreviewWebviewBoundsRequest = { id: string; bounds: PreviewWebviewBounds };

export type PreviewWebviewVisibilityRequest = { id: string; visible: boolean };

export type PreviewWebviewCloseRequest = { id: string };

export type PreviewWebviewCaptureRequest = { id: string };

export type PreviewWebviewSnapshot = { dataUrl: string | null };

export type PreviewColorScheme = "light" | "dark";

export type DesktopUpdateInfo = {
  currentVersion: string;
  version: string;
  notes: string | null;
  publishedAt: string | null;
};

export type DesktopUpdateProgress =
  | { event: "started"; data: { contentLength: number | null } }
  | { event: "progress"; data: { chunkLength: number } }
  | { event: "downloaded" }
  | { event: "installing" };

export type NativeErrorCode =
  | "invalid_url"
  | "capability_denied"
  | "invalid_caller"
  | "invalid_storage_key"
  | "invalid_value"
  | "clipboard_unavailable"
  | "download_directory_unavailable"
  | "download_save_unavailable"
  | "secure_storage_unavailable"
  | "invalid_deep_link"
  | "invalid_preview_id"
  | "invalid_bounds"
  | "preview_unavailable"
  | "update_busy"
  | "update_check_failed"
  | "no_pending_update"
  | "update_install_failed";

export type NativeError = { code: NativeErrorCode; message: string };
