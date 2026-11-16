//! Best-effort, memory-only viewport capture. No page script or arbitrary CDP command is exposed.

#[cfg(target_os = "windows")]
pub async fn capture(preview: &tauri::Webview) -> Option<String> {
    use std::{sync::mpsc, time::Duration};
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::w;

    let (sender, receiver) = mpsc::channel();
    preview
        .with_webview(move |webview| {
            // Both the controller and the completion handler stay on the WebView's UI thread.
            let result = unsafe { webview.controller().CoreWebView2() };
            let Ok(core) = result else { return };
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |status, response| {
                    let snapshot = status.ok().and_then(|_| snapshot_data_url(&response));
                    let _ = sender.send(snapshot);
                    Ok(())
                },
            ));
            // Fixed method/parameters only. This captures the viewport, not the full scrolling page.
            let _ = unsafe {
                core.CallDevToolsProtocolMethod(
                    w!("Page.captureScreenshot"),
                    w!(r#"{"format":"png","captureBeyondViewport":false}"#),
                    &handler,
                )
            };
        })
        .ok()?;

    // Never block the UI thread. A stalled renderer must not indefinitely block menu/tab operations.
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_millis(1200))
            .ok()
            .flatten()
    })
    .await
    .ok()
    .flatten()
}

#[cfg(not(target_os = "windows"))]
pub async fn capture(_preview: &tauri::Webview) -> Option<String> {
    None
}

#[cfg(any(target_os = "windows", test))]
fn snapshot_data_url(response: &str) -> Option<String> {
    // Bound IPC/memory use; complex very large viewports fall back to the temporary pause notice.
    if response.len() > 16 * 1024 * 1024 {
        return None;
    }
    let response: serde_json::Value = serde_json::from_str(response).ok()?;
    let data = response.get("data")?.as_str()?;
    if !data.starts_with("iVBORw0KGgo")
        || !data
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte))
    {
        return None;
    }
    Some(format!("data:image/png;base64,{data}"))
}

#[cfg(test)]
mod tests {
    use super::snapshot_data_url;

    #[test]
    fn accepts_only_bounded_png_data() {
        assert_eq!(
            snapshot_data_url(r#"{"data":"iVBORw0KGgoAAA=="}"#),
            Some("data:image/png;base64,iVBORw0KGgoAAA==".into())
        );
        for response in [
            "{}",
            "null",
            "not json",
            r#"{"data":"javascript:alert(1)"}"#,
            r#"{"data":"iVBORw0KGgo<script>"}"#,
        ] {
            assert!(snapshot_data_url(response).is_none());
        }
        assert!(snapshot_data_url(&"x".repeat(16 * 1024 * 1024 + 1)).is_none());
    }
}
