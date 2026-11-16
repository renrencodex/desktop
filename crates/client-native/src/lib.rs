use url::Url;

pub use client_protocol::{
    ClipboardWriteRequest, DeepLinkPayload, DesktopUpdateInfo, DesktopUpdateProgress,
    MobileDownloadCreateRequest, MobileDownloadWriteRequest, MobileDownloadWriteResponse,
    MobileDownloadWriterRequest, MobileDownloadWriterResponse, NativeError, NativeErrorCode,
    PreviewColorScheme, PreviewWebviewBounds, PreviewWebviewBoundsRequest,
    PreviewWebviewCaptureRequest, PreviewWebviewCloseRequest, PreviewWebviewOpenRequest,
    PreviewWebviewSnapshot, PreviewWebviewVisibilityRequest, SecureStorageKey,
};

pub const DESKTOP_REFRESH_TOKEN_KEY: &str = "desktop-refresh-token";
pub const MOBILE_REFRESH_TOKEN_KEY: &str = "mobile-refresh-token";
// User-initiated terminal selections can legitimately contain substantial
// scrollback. OSC 52 remains capped at 64 KiB by the renderer before IPC.
pub const MAX_CLIPBOARD_TEXT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_MOBILE_DOWNLOAD_CHUNK_BASE64_BYTES: usize = 1_400_000;

fn invalid_deep_link() -> NativeError {
    NativeError {
        code: NativeErrorCode::InvalidDeepLink,
        message: "invalid desktop OAuth callback URL".into(),
    }
}

fn invalid_mobile_app_link() -> NativeError {
    NativeError {
        code: NativeErrorCode::InvalidDeepLink,
        message: "invalid Android app link".into(),
    }
}

pub fn validate_external_url(value: &str) -> Result<Url, NativeError> {
    let url = Url::parse(value).map_err(|_| NativeError {
        code: NativeErrorCode::InvalidUrl,
        message: "invalid external URL".into(),
    })?;
    if url.scheme() != "https" {
        return Err(NativeError {
            code: NativeErrorCode::InvalidUrl,
            message: "only HTTPS external URLs are allowed".into(),
        });
    }
    Ok(url)
}

pub fn validate_secure_storage_key(value: &str) -> Result<SecureStorageKey, NativeError> {
    match value {
        DESKTOP_REFRESH_TOKEN_KEY => Ok(SecureStorageKey::DesktopRefreshToken),
        MOBILE_REFRESH_TOKEN_KEY => Ok(SecureStorageKey::MobileRefreshToken),
        _ => Err(NativeError {
            code: NativeErrorCode::InvalidStorageKey,
            message: "unsupported secure storage key".into(),
        }),
    }
}

pub fn validate_clipboard_text(value: &str) -> Result<(), NativeError> {
    if value.len() <= MAX_CLIPBOARD_TEXT_BYTES {
        Ok(())
    } else {
        Err(NativeError {
            code: NativeErrorCode::InvalidValue,
            message: "clipboard text exceeds the supported size".into(),
        })
    }
}

pub fn validate_mobile_download_create(
    request: &MobileDownloadCreateRequest,
) -> Result<(), NativeError> {
    let valid_file_name = !request.file_name.is_empty()
        && request.file_name.chars().count() <= 255
        && !request
            .file_name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'));
    let mut mime_parts = request.mime_type.split('/');
    let valid_mime = request.mime_type.len() <= 100
        && mime_parts.next().is_some_and(valid_mime_part)
        && mime_parts.next().is_some_and(valid_mime_part)
        && mime_parts.next().is_none();
    if valid_file_name && valid_mime {
        Ok(())
    } else {
        Err(NativeError {
            code: NativeErrorCode::InvalidValue,
            message: "invalid mobile download destination".into(),
        })
    }
}

pub fn validate_mobile_download_write(
    request: &MobileDownloadWriteRequest,
) -> Result<(), NativeError> {
    if !request.id.is_empty()
        && request.id.len() <= 64
        && !request.data.is_empty()
        && request.data.len() <= MAX_MOBILE_DOWNLOAD_CHUNK_BASE64_BYTES
    {
        Ok(())
    } else {
        Err(NativeError {
            code: NativeErrorCode::InvalidValue,
            message: "invalid mobile download chunk".into(),
        })
    }
}

pub fn validate_mobile_download_writer(
    request: &MobileDownloadWriterRequest,
) -> Result<(), NativeError> {
    if !request.id.is_empty() && request.id.len() <= 64 {
        Ok(())
    } else {
        Err(NativeError {
            code: NativeErrorCode::InvalidValue,
            message: "invalid mobile download writer".into(),
        })
    }
}

fn valid_mime_part(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'_' | b'-'))
}

pub fn validate_desktop_oauth_callback(value: &str) -> Result<Url, NativeError> {
    if value.len() > 8_192 || value.chars().any(char::is_control) {
        return Err(invalid_deep_link());
    }

    let mut url = Url::parse(value).map_err(|_| invalid_deep_link())?;
    if url.scheme() != "renrencodex"
        || url.host_str() != Some("oauth")
        || url.path() != "/callback"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid_deep_link());
    }

    let mut code = None;
    let mut state = None;
    for (name, value) in url.query_pairs() {
        if value.is_empty() || value.len() > 4_096 {
            return Err(invalid_deep_link());
        }
        match name.as_ref() {
            "code" if code.is_none() => code = Some(value.into_owned()),
            "state" if state.is_none() => state = Some(value.into_owned()),
            _ => return Err(invalid_deep_link()),
        }
    }
    let (code, state) = match (code, state) {
        (Some(code), Some(state)) => (code, state),
        _ => return Err(invalid_deep_link()),
    };

    url.set_query(None);
    url.query_pairs_mut()
        .append_pair("code", &code)
        .append_pair("state", &state);
    Ok(url)
}

/** Android 只接管明确的账户与支付回跳路径，拒绝开放重定向和模糊参数。 */
pub fn validate_mobile_app_link(value: &str) -> Result<Url, NativeError> {
    if value.len() > 8_192 || value.chars().any(char::is_control) {
        return Err(invalid_mobile_app_link());
    }
    let url = Url::parse(value).map_err(|_| invalid_mobile_app_link())?;
    if url.scheme() != "https"
        || url.host_str() != Some("renrencodex.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(invalid_mobile_app_link());
    }

    let pairs = url.query_pairs().collect::<Vec<_>>();
    let valid = match url.path() {
        "/reset-password" => {
            pairs.is_empty()
                && url
                    .fragment()
                    .is_some_and(|token| is_url_token(token, 43, 43))
        }
        "/register" => {
            url.fragment().is_none()
                && (pairs.is_empty()
                    || (pairs.len() == 1
                        && match pairs[0].0.as_ref() {
                            "ref" => is_url_token(&pairs[0].1, 1, 100),
                            "invite" => is_url_token(&pairs[0].1, 1, 200),
                            _ => false,
                        }))
        }
        "/referrals/accept" => {
            url.fragment().is_none()
                && pairs.len() == 1
                && pairs[0].0 == "token"
                && is_url_token(&pairs[0].1, 1, 200)
        }
        "/app/android/payment/callback" => {
            url.fragment().is_none()
                && pairs.len() == 1
                && pairs[0].0 == "order"
                && is_url_token(&pairs[0].1, 1, 100)
        }
        _ => false,
    };
    if valid {
        Ok(url)
    } else {
        Err(invalid_mobile_app_link())
    }
}

fn is_url_token(value: &str, minimum: usize, maximum: usize) -> bool {
    (minimum..=maximum).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_is_allowed() {
        assert!(validate_external_url("https://example.com/path").is_ok());
        assert!(validate_external_url("http://example.com").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn only_declared_refresh_token_keys_are_allowed() {
        assert_eq!(
            validate_secure_storage_key(DESKTOP_REFRESH_TOKEN_KEY).unwrap(),
            SecureStorageKey::DesktopRefreshToken
        );
        assert_eq!(
            validate_secure_storage_key(MOBILE_REFRESH_TOKEN_KEY).unwrap(),
            SecureStorageKey::MobileRefreshToken
        );
        let error = validate_secure_storage_key("another-key").unwrap_err();
        assert_eq!(error.code, NativeErrorCode::InvalidStorageKey);
        assert!(!error.message.contains("another-key"));
    }

    #[test]
    fn user_clipboard_text_allows_long_selections_and_is_bounded_by_utf8_bytes() {
        assert!(validate_clipboard_text(&"a".repeat(64 * 1024 + 1)).is_ok());
        assert!(validate_clipboard_text(&"a".repeat(MAX_CLIPBOARD_TEXT_BYTES)).is_ok());
        let error =
            validate_clipboard_text(&"界".repeat(MAX_CLIPBOARD_TEXT_BYTES / 3 + 1)).unwrap_err();
        assert_eq!(error.code, NativeErrorCode::InvalidValue);
    }

    #[test]
    fn mobile_download_requests_are_narrowly_bounded() {
        assert!(
            validate_mobile_download_create(&MobileDownloadCreateRequest {
                file_name: "source.tar.gz".into(),
                mime_type: "application/octet-stream".into(),
            })
            .is_ok()
        );
        for file_name in ["", "../secret", "dir/file", "bad\0name"] {
            assert!(
                validate_mobile_download_create(&MobileDownloadCreateRequest {
                    file_name: file_name.into(),
                    mime_type: "application/octet-stream".into(),
                })
                .is_err()
            );
        }
        assert!(
            validate_mobile_download_write(&MobileDownloadWriteRequest {
                id: "writer-id".into(),
                data: "YQ==".into(),
            })
            .is_ok()
        );
    }

    #[test]
    fn accepts_and_canonicalizes_desktop_oauth_callback() {
        let url = validate_desktop_oauth_callback(
            "renrencodex://oauth/callback?state=state%20value&code=code%2Fvalue",
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "renrencodex://oauth/callback?code=code%2Fvalue&state=state+value"
        );
    }

    #[test]
    fn rejects_untrusted_or_ambiguous_deep_links() {
        for value in [
            "https://oauth/callback?code=a&state=b",
            "renrencodex://evil/callback?code=a&state=b",
            "renrencodex://oauth/other?code=a&state=b",
            "renrencodex://oauth/callback?code=a",
            "renrencodex://oauth/callback?code=a&state=b&next=https://evil.example",
            "renrencodex://oauth/callback?code=a&code=b&state=c",
            "renrencodex://oauth/callback?code=&state=b",
            "renrencodex://oauth/callback?code=a&state=b#fragment",
        ] {
            assert!(
                validate_desktop_oauth_callback(value).is_err(),
                "{value} should be rejected"
            );
        }
    }

    #[test]
    fn accepts_only_scoped_android_app_links() {
        for value in [
            "https://renrencodex.com/register?ref=friend_01",
            "https://renrencodex.com/register?invite=invite.token-1",
            "https://renrencodex.com/reset-password#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "https://renrencodex.com/referrals/accept?token=invite.token-1",
            "https://renrencodex.com/app/android/payment/callback?order=01ORDER",
        ] {
            assert!(validate_mobile_app_link(value).is_ok(), "{value}");
        }
        for value in [
            "http://renrencodex.com/register",
            "https://evil.example/reset-password?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "https://renrencodex.com/reset-password#short",
            "https://renrencodex.com/reset-password?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "https://renrencodex.com/register?ref=one&invite=two",
            "https://renrencodex.com/other",
            "https://renrencodex.com/register#fragment",
        ] {
            assert!(validate_mobile_app_link(value).is_err(), "{value}");
        }
    }
}
