use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct OpenExternalRequest {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardWriteRequest {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRequest {
    pub title: String,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
pub enum SecureStorageKey {
    #[serde(rename = "desktop-refresh-token")]
    DesktopRefreshToken,
    #[serde(rename = "mobile-refresh-token")]
    MobileRefreshToken,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecureStorageGetRequest {
    pub key: SecureStorageKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecureStorageSetRequest {
    pub key: SecureStorageKey,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkPayload {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct MobileDownloadCreateRequest {
    pub file_name: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct MobileDownloadWriterRequest {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct MobileDownloadWriteRequest {
    pub id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct MobileDownloadWriterResponse {
    pub id: String,
    #[ts(type = "number")]
    pub position: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct MobileDownloadWriteResponse {
    #[ts(type = "number")]
    pub position: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWebviewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWebviewOpenRequest {
    pub id: String,
    pub url: String,
    pub bounds: PreviewWebviewBounds,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWebviewBoundsRequest {
    pub id: String,
    pub bounds: PreviewWebviewBounds,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWebviewVisibilityRequest {
    pub id: String,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWebviewCloseRequest {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWebviewCaptureRequest {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWebviewSnapshot {
    pub data_url: Option<String>,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
pub enum PreviewColorScheme {
    #[default]
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateInfo {
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub enum DesktopUpdateProgress {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: f64,
    },
    Downloaded,
    Installing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum NativeErrorCode {
    InvalidUrl,
    CapabilityDenied,
    InvalidCaller,
    InvalidStorageKey,
    InvalidValue,
    ClipboardUnavailable,
    DownloadDirectoryUnavailable,
    DownloadSaveUnavailable,
    SecureStorageUnavailable,
    InvalidDeepLink,
    InvalidPreviewId,
    InvalidBounds,
    PreviewUnavailable,
    UpdateBusy,
    UpdateCheckFailed,
    NoPendingUpdate,
    UpdateInstallFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct NativeError {
    pub code: NativeErrorCode,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_storage_keys_use_stable_wire_names() {
        assert_eq!(
            serde_json::to_string(&SecureStorageKey::DesktopRefreshToken).unwrap(),
            "\"desktop-refresh-token\""
        );
        assert_eq!(
            serde_json::to_string(&SecureStorageKey::MobileRefreshToken).unwrap(),
            "\"mobile-refresh-token\""
        );
    }

    #[test]
    fn preview_theme_accepts_only_explicit_light_or_dark() {
        for (value, expected) in [
            ("light", PreviewColorScheme::Light),
            ("dark", PreviewColorScheme::Dark),
        ] {
            assert_eq!(
                serde_json::from_value::<PreviewColorScheme>(serde_json::json!(value)).unwrap(),
                expected
            );
        }
        for value in ["auto", "system", "", "Dark"] {
            assert!(
                serde_json::from_value::<PreviewColorScheme>(serde_json::json!(value)).is_err()
            );
        }
    }
}
