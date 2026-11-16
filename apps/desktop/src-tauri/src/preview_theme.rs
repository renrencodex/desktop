//! Only a fixed light/dark preference is accepted; remote previews cannot call this code.

use client_native::{NativeError, PreviewColorScheme};

#[cfg(target_os = "windows")]
pub async fn apply(
    preview: &tauri::Webview,
    scheme: PreviewColorScheme,
    lifetime: &super::preview_lifecycle::Lifetime,
) -> Result<(), NativeError> {
    use std::{sync::mpsc, time::Duration};
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, Microsoft::Web::WebView2::Win32::*,
    };
    use windows::core::{Interface, PCWSTR, w};

    let (sender, receiver) = mpsc::channel();
    let lifetime = lifetime.clone();
    preview
        .with_webview(move |webview| {
            if lifetime.check().is_err() {
                let _ = sender.send(Err("preview document was replaced"));
                return;
            }
            let completed = sender.clone();
            // COM objects must stay on the WebView's UI thread. Do not use page JS or CSS overrides.
            let result = (|| -> windows::core::Result<()> {
                let core = unsafe { webview.controller().CoreWebView2()? };
                let profile = unsafe { core.cast::<ICoreWebView2_13>()?.Profile()? };
                let preference = match scheme {
                    PreviewColorScheme::Light => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT,
                    PreviewColorScheme::Dark => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK,
                };
                unsafe { profile.SetPreferredColorScheme(preference)? };
                let mut actual = COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO;
                unsafe { profile.PreferredColorScheme(&mut actual)? };
                if actual != preference {
                    let _ = sender.send(Err("WebView2 did not accept the color preference"));
                    return Ok(());
                }
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |status, _| {
                        let _ = completed.send(status.map_err(|_| "preview media theme failed"));
                        Ok(())
                    },
                ));
                let params: Vec<u16> = media_parameters(scheme).encode_utf16().chain([0]).collect();
                unsafe {
                    core.CallDevToolsProtocolMethod(
                        w!("Emulation.setEmulatedMedia"),
                        PCWSTR(params.as_ptr()),
                        &handler,
                    )
                }
            })();
            if result.is_err() {
                let _ = sender.send(Err("WebView2 theme synchronization failed"));
            }
        })
        .map_err(|_| super::preview_unavailable())?;

    // Bound stalled renderer/UI callbacks without blocking the main thread.
    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_millis(1200))
            .unwrap_or(Err("preview theme synchronization timed out"))
    })
    .await
    .map_err(|_| super::preview_unavailable())?;
    result.map_err(|message| NativeError {
        code: client_native::NativeErrorCode::PreviewUnavailable,
        message: message.into(),
    })
}

#[cfg(not(target_os = "windows"))]
pub async fn apply(
    _preview: &tauri::Webview,
    _scheme: PreviewColorScheme,
    lifetime: &super::preview_lifecycle::Lifetime,
) -> Result<(), NativeError> {
    // Other platforms continue to use Tauri's window theme propagation.
    lifetime.check()
}

#[cfg(any(target_os = "windows", test))]
fn media_parameters(scheme: PreviewColorScheme) -> &'static str {
    match scheme {
        PreviewColorScheme::Light => {
            r#"{"features":[{"name":"prefers-color-scheme","value":"light"}]}"#
        }
        PreviewColorScheme::Dark => {
            r#"{"features":[{"name":"prefers-color-scheme","value":"dark"}]}"#
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_sets_the_selected_color_scheme() {
        for (scheme, expected) in [
            (PreviewColorScheme::Light, "light"),
            (PreviewColorScheme::Dark, "dark"),
        ] {
            let value: serde_json::Value = serde_json::from_str(media_parameters(scheme)).unwrap();
            assert_eq!(
                value,
                serde_json::json!({"features": [{"name": "prefers-color-scheme", "value": expected}]})
            );
        }
    }
}
