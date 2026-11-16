use std::{fs, path::PathBuf};

use client_protocol::{
    ClipboardWriteRequest, DeepLinkPayload, DesktopUpdateInfo, DesktopUpdateProgress,
    MobileDownloadCreateRequest, MobileDownloadWriteRequest, MobileDownloadWriteResponse,
    MobileDownloadWriterRequest, MobileDownloadWriterResponse, NativeError, NativeErrorCode,
    NotificationRequest, OpenExternalRequest, PreviewColorScheme, PreviewWebviewBounds,
    PreviewWebviewBoundsRequest, PreviewWebviewCaptureRequest, PreviewWebviewCloseRequest,
    PreviewWebviewOpenRequest, PreviewWebviewSnapshot, PreviewWebviewVisibilityRequest,
    SecureStorageGetRequest, SecureStorageKey, SecureStorageSetRequest,
};
use ts_rs::TS;

fn main() {
    let declarations = [
        OpenExternalRequest::decl(),
        ClipboardWriteRequest::decl(),
        NotificationRequest::decl(),
        SecureStorageKey::decl(),
        SecureStorageGetRequest::decl(),
        SecureStorageSetRequest::decl(),
        DeepLinkPayload::decl(),
        MobileDownloadCreateRequest::decl(),
        MobileDownloadWriterRequest::decl(),
        MobileDownloadWriteRequest::decl(),
        MobileDownloadWriterResponse::decl(),
        MobileDownloadWriteResponse::decl(),
        PreviewWebviewBounds::decl(),
        PreviewWebviewOpenRequest::decl(),
        PreviewWebviewBoundsRequest::decl(),
        PreviewWebviewVisibilityRequest::decl(),
        PreviewWebviewCloseRequest::decl(),
        PreviewWebviewCaptureRequest::decl(),
        PreviewWebviewSnapshot::decl(),
        PreviewColorScheme::decl(),
        DesktopUpdateInfo::decl(),
        DesktopUpdateProgress::decl(),
        NativeErrorCode::decl(),
        NativeError::decl(),
    ]
    .map(|declaration| format!("export {declaration}"));
    let output = format!(
        "// Generated from crates/client-protocol. Do not edit.\n\n{}\n",
        declarations.join("\n\n")
    );
    let output_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/platform-api/src/generated/client-protocol.ts");
    fs::create_dir_all(output_path.parent().expect("generated output has a parent"))
        .expect("create generated TypeScript directory");
    fs::write(output_path, output).expect("write generated TypeScript protocol");
}
