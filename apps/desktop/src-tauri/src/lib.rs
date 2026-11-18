use std::{
    io,
    path::PathBuf,
    sync::{Mutex, atomic::AtomicBool},
};

#[cfg(unix)]
use std::{
    fs,
    fs::OpenOptions,
    os::unix::fs::PermissionsExt,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use client_native::{
    ClipboardWriteRequest, DESKTOP_REFRESH_TOKEN_KEY, DeepLinkPayload, DesktopUpdateInfo,
    DesktopUpdateProgress, NativeError, NativeErrorCode, PreviewColorScheme, PreviewWebviewBounds,
    PreviewWebviewBoundsRequest, PreviewWebviewCaptureRequest, PreviewWebviewCloseRequest,
    PreviewWebviewOpenRequest, PreviewWebviewSnapshot, PreviewWebviewVisibilityRequest,
    SecureStorageKey, validate_clipboard_text, validate_desktop_oauth_callback,
    validate_external_url, validate_secure_storage_key,
};
use tauri::{Emitter, Manager, Url, WebviewUrl, ipc::Channel, webview::PageLoadEvent};
use tauri::{LogicalPosition, LogicalSize, Rect, WebviewBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

mod desktop_tray;
mod preview_lifecycle;
mod preview_snapshot;
mod preview_theme;
#[cfg(any(target_os = "windows", test))]
mod window_startup;

const DEEP_LINK_EVENT: &str = "desktop-deep-link";
const DESKTOP_EXIT_REQUESTED_EVENT: &str = "desktop-exit-requested";
const KEYRING_SERVICE: &str = "com.renrencodex.desktop";
const MAX_SECRET_LENGTH: usize = 64 * 1024;
const PREVIEW_PERMISSION_GUARD: &str = include_str!("preview-permission-guard.txt");
const DESKTOP_UPDATE_ENDPOINT: &str =
    "https://renrencodex.com/downloads/desktop/stable/latest.json";
const DESKTOP_UPDATE_ARTIFACT_BASE: &str = "https://renrencodex.com/downloads/desktop/stable";

const UPDATER_PUBLIC_KEY: Option<&str> = option_env!("RENRENCODEX_UPDATER_PUBLIC_KEY");

#[derive(Default)]
struct DeepLinkState {
    inner: Mutex<DeepLinkStateInner>,
}

#[derive(Default)]
struct DeepLinkStateInner {
    pending: Option<String>,
    last_dispatched: Option<String>,
}

#[derive(Default)]
struct PreviewWebviewState {
    registry: preview_lifecycle::Registry,
    // Serializes theme changes with creation/reuse, including hidden tabs.
    theme: tauri::async_runtime::Mutex<PreviewColorScheme>,
}

#[derive(Default)]
struct DesktopUpdateState {
    pending: Mutex<Option<Update>>,
    busy: AtomicBool,
}

#[derive(Default)]
struct DesktopLifecycleState {
    exit_pending: AtomicBool,
}

#[derive(Default)]
struct NativeConnectorState {
    path: Mutex<Option<PathBuf>>,
}

impl DesktopLifecycleState {
    fn request_exit(&self) {
        self.exit_pending
            .store(true, std::sync::atomic::Ordering::Release);
    }

    fn take_exit(&self) -> bool {
        self.exit_pending
            .swap(false, std::sync::atomic::Ordering::AcqRel)
    }
}

#[derive(Debug)]
struct UpdateBusyGuard<'a>(&'a AtomicBool);

impl Drop for UpdateBusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

impl PreviewWebviewState {
    fn unregister(&self, label: &str) -> Result<(), NativeError> {
        self.registry.unregister(label)
    }

    fn take_all(&self) -> Result<Vec<String>, NativeError> {
        self.registry.take_all()
    }

    fn restore(&self, labels: impl IntoIterator<Item = String>) {
        self.registry.restore(labels);
    }
}

fn ensure_main_webview(label: &str) -> Result<(), NativeError> {
    if label == "main" {
        Ok(())
    } else {
        Err(NativeError {
            code: NativeErrorCode::InvalidCaller,
            message: "command is only available to the main webview".into(),
        })
    }
}

fn bundled_native_connector_path() -> io::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let directory = executable
        .parent()
        .ok_or_else(|| io::Error::other("desktop executable has no parent directory"))?;
    #[cfg(target_os = "windows")]
    let file_name = "renrencodex-connect.exe";
    #[cfg(not(target_os = "windows"))]
    let file_name = "renrencodex-connect";
    Ok(directory.join(file_name))
}

#[cfg(unix)]
fn install_native_connector(source: &Path, destination: &Path) -> io::Result<()> {
    if !source.metadata()?.is_file() {
        return Err(io::Error::other("bundled native connector is not a file"));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::other("native connector destination has no parent"))?;
    fs::create_dir_all(parent)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    let temporary = destination.with_extension(format!("tmp-{}-{nonce}", std::process::id()));
    let result = (|| {
        let mut source_file = fs::File::open(source)?;
        let mut temporary_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        io::copy(&mut source_file, &mut temporary_file)?;
        temporary_file.set_permissions(fs::Permissions::from_mode(0o700))?;
        temporary_file.sync_all()?;
        drop(temporary_file);
        fs::rename(&temporary, destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn prepare_native_connector(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let source = bundled_native_connector_path()
        .map_err(|error| format!("failed to locate bundled native connector: {error}"))?;
    if !source
        .metadata()
        .map_err(|error| format!("failed to inspect bundled native connector: {error}"))?
        .is_file()
    {
        return Err("bundled native connector is not a file".into());
    }
    #[cfg(unix)]
    {
        let destination = app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("failed to resolve desktop data directory: {error}"))?
            .join("bin")
            .join("renrencodex-connect");
        install_native_connector(&source, &destination)
            .map_err(|error| format!("failed to install native connector: {error}"))?;
        Ok(destination)
    }
    #[cfg(target_os = "windows")]
    {
        Ok(source)
    }
}

#[tauri::command]
fn native_connector_path(
    webview: tauri::Webview,
    state: tauri::State<'_, NativeConnectorState>,
) -> Result<Option<String>, NativeError> {
    ensure_main_webview(webview.label())?;
    let path = state.path.lock().map_err(|_| NativeError {
        code: NativeErrorCode::CapabilityDenied,
        message: "native connector state is unavailable".into(),
    })?;
    Ok(path
        .as_ref()
        .and_then(|value| value.to_str())
        .filter(|value| !value.chars().any(char::is_control))
        .map(str::to_owned))
}

#[tauri::command]
fn desktop_startup_ready(webview: tauri::Webview) -> Result<(), NativeError> {
    ensure_main_webview(webview.label())?;
    #[cfg(target_os = "windows")]
    window_startup::ready(webview.app_handle());
    Ok(())
}

fn desktop_startup_pending(app: &tauri::AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    {
        window_startup::is_pending(app)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        false
    }
}

fn restore_main_window(app: &tauri::AppHandle) {
    if desktop_startup_pending(app) {
        #[cfg(target_os = "windows")]
        window_startup::recover(app);
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(error) = window.unminimize() {
        eprintln!("failed to unminimize main desktop window: {error}");
    }
    if let Err(error) = window.show() {
        eprintln!("failed to show main desktop window: {error}");
    }
    if let Err(error) = window.set_focus() {
        eprintln!("failed to focus main desktop window: {error}");
    }
}

fn request_desktop_exit(app: &tauri::AppHandle) {
    if app.get_webview_window("main").is_none() {
        app.exit(0);
        return;
    }
    app.state::<DesktopLifecycleState>().request_exit();
    let _ = app.emit_to("main", DESKTOP_EXIT_REQUESTED_EVENT, ());
}

#[tauri::command]
fn desktop_restore(webview: tauri::Webview, app: tauri::AppHandle) -> Result<(), NativeError> {
    ensure_main_webview(webview.label())?;
    restore_main_window(&app);
    Ok(())
}

#[tauri::command]
fn take_pending_desktop_exit(
    webview: tauri::Webview,
    state: tauri::State<'_, DesktopLifecycleState>,
) -> Result<bool, NativeError> {
    ensure_main_webview(webview.label())?;
    Ok(state.take_exit())
}

#[tauri::command]
fn desktop_exit(webview: tauri::Webview, app: tauri::AppHandle) -> Result<(), NativeError> {
    ensure_main_webview(webview.label())?;
    app.exit(0);
    Ok(())
}

fn preview_unavailable() -> NativeError {
    NativeError {
        code: NativeErrorCode::PreviewUnavailable,
        message: "isolated preview is unavailable".into(),
    }
}

fn validate_preview_id(id: &str) -> Result<String, NativeError> {
    if !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Ok(format!("preview-{id}"))
    } else {
        Err(NativeError {
            code: NativeErrorCode::InvalidPreviewId,
            message: "invalid preview identifier".into(),
        })
    }
}

fn validate_preview_url(value: &str) -> Result<Url, NativeError> {
    if value.len() > 8_192 || value.chars().any(char::is_control) {
        return Err(NativeError {
            code: NativeErrorCode::InvalidUrl,
            message: "invalid preview URL".into(),
        });
    }
    let url = Url::parse(value).map_err(|_| NativeError {
        code: NativeErrorCode::InvalidUrl,
        message: "invalid preview URL".into(),
    })?;
    let host = url.host_str().unwrap_or_default();
    let production_preview = url.scheme() == "https"
        && host
            .strip_suffix(".preview.renrencodex.com")
            .is_some_and(|prefix| !prefix.is_empty() && !prefix.ends_with('.'));
    let development_preview = cfg!(debug_assertions)
        && matches!(url.scheme(), "http" | "https")
        && (matches!(host, "localhost" | "127.0.0.1" | "::1") || host.ends_with(".localhost"));
    if (!production_preview && !development_preview)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(NativeError {
            code: NativeErrorCode::InvalidUrl,
            message: "preview URL is not allowed".into(),
        });
    }
    Ok(url)
}

fn validate_preview_bounds(bounds: PreviewWebviewBounds) -> Result<Rect, NativeError> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if values
        .iter()
        .any(|value| !value.is_finite() || value.abs() > 100_000.0)
        || bounds.width < 1.0
        || bounds.height < 1.0
    {
        return Err(NativeError {
            code: NativeErrorCode::InvalidBounds,
            message: "invalid preview bounds".into(),
        });
    }
    Ok(Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width, bounds.height).into(),
    })
}

fn same_origin(candidate: &Url, allowed: &Url) -> bool {
    candidate.origin() == allowed.origin()
}

fn close_registered_previews(app: &tauri::AppHandle) {
    let state = app.state::<PreviewWebviewState>();
    let Ok(labels) = state.take_all() else {
        return;
    };
    let failed = labels.into_iter().filter(|label| {
        app.get_webview(label)
            .is_some_and(|preview| preview.close().is_err())
    });
    state.restore(failed);
}

fn storage_unavailable() -> NativeError {
    NativeError {
        code: NativeErrorCode::SecureStorageUnavailable,
        message: "secure storage is unavailable".into(),
    }
}

fn update_error(code: NativeErrorCode, message: &str) -> NativeError {
    NativeError {
        code,
        message: message.into(),
    }
}

fn begin_update_operation(state: &DesktopUpdateState) -> Result<UpdateBusyGuard<'_>, NativeError> {
    state
        .busy
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .map_err(|_| {
            update_error(
                NativeErrorCode::UpdateBusy,
                "an update operation is in progress",
            )
        })?;
    Ok(UpdateBusyGuard(&state.busy))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DesktopUpdateTarget {
    WindowsX86_64,
    MacosUniversal,
    LinuxX86_64,
}

fn desktop_update_target(
    operating_system: &str,
    architecture: &str,
    linux_appimage: bool,
) -> Option<DesktopUpdateTarget> {
    match (operating_system, architecture) {
        ("windows", "x86_64") => Some(DesktopUpdateTarget::WindowsX86_64),
        ("macos", "aarch64" | "x86_64") => Some(DesktopUpdateTarget::MacosUniversal),
        ("linux", "x86_64") if linux_appimage => Some(DesktopUpdateTarget::LinuxX86_64),
        _ => None,
    }
}

fn current_desktop_update_target() -> Result<DesktopUpdateTarget, NativeError> {
    let linux_appimage = cfg!(target_os = "linux")
        && std::env::var_os("APPIMAGE").is_some_and(|value| !value.is_empty());
    desktop_update_target(std::env::consts::OS, std::env::consts::ARCH, linux_appimage).ok_or_else(
        || {
            update_error(
                NativeErrorCode::CapabilityDenied,
                "desktop updates require Windows x64, macOS Universal, or Linux x64 AppImage",
            )
        },
    )
}

fn expected_desktop_update_url(
    target: DesktopUpdateTarget,
    version: &str,
) -> Result<Url, NativeError> {
    let path = match target {
        DesktopUpdateTarget::WindowsX86_64 => {
            format!("windows-x86_64/renrencodex-desktop-{version}-x64.msi")
        }
        DesktopUpdateTarget::MacosUniversal => {
            format!("macos-universal/renrencodex-desktop-{version}-universal.app.tar.gz")
        }
        DesktopUpdateTarget::LinuxX86_64 => {
            format!("linux-x86_64/renrencodex-desktop-{version}-x86_64.AppImage")
        }
    };
    Url::parse(&format!("{DESKTOP_UPDATE_ARTIFACT_BASE}/{path}")).map_err(|_| {
        update_error(
            NativeErrorCode::UpdateCheckFailed,
            "desktop update artifact URL is invalid",
        )
    })
}

fn keyring_entry(key: &str) -> Result<keyring::Entry, NativeError> {
    if validate_secure_storage_key(key)? != SecureStorageKey::DesktopRefreshToken {
        return Err(NativeError {
            code: NativeErrorCode::InvalidStorageKey,
            message: "unsupported secure storage key".into(),
        });
    }
    keyring::Entry::new(KEYRING_SERVICE, DESKTOP_REFRESH_TOKEN_KEY)
        .map_err(|_| storage_unavailable())
}

#[tauri::command]
fn secure_storage_get(webview: tauri::Webview, key: String) -> Result<Option<String>, NativeError> {
    ensure_main_webview(webview.label())?;
    match keyring_entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(storage_unavailable()),
    }
}

#[tauri::command]
fn secure_storage_set(
    webview: tauri::Webview,
    key: String,
    value: String,
) -> Result<(), NativeError> {
    ensure_main_webview(webview.label())?;
    if value.is_empty() || value.len() > MAX_SECRET_LENGTH {
        return Err(NativeError {
            code: NativeErrorCode::InvalidValue,
            message: "invalid secure storage value".into(),
        });
    }
    keyring_entry(&key)?
        .set_password(&value)
        .map_err(|_| storage_unavailable())
}

#[tauri::command]
fn secure_storage_remove(webview: tauri::Webview, key: String) -> Result<(), NativeError> {
    ensure_main_webview(webview.label())?;
    match keyring_entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(storage_unavailable()),
    }
}

#[tauri::command]
fn take_pending_deep_link(
    webview: tauri::Webview,
    state: tauri::State<'_, DeepLinkState>,
) -> Result<Option<DeepLinkPayload>, NativeError> {
    ensure_main_webview(webview.label())?;
    let mut state = state.inner.lock().map_err(|_| NativeError {
        code: NativeErrorCode::CapabilityDenied,
        message: "deep link state is unavailable".into(),
    })?;
    Ok(state.pending.take().map(|url| DeepLinkPayload { url }))
}

/// 受控打开外部链接：仅允许 https；桌面走系统浏览器，移动端经 opener
/// 插件走系统 Intent / UIApplication。
#[tauri::command]
fn open_external(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    url: String,
) -> Result<(), NativeError> {
    ensure_main_webview(webview.label())?;
    let url = validate_external_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| NativeError {
            code: NativeErrorCode::CapabilityDenied,
            message: "failed to open URL in the system browser".into(),
        })
}

/// 打开 WebView 下载管理器使用的系统下载目录。路径完全由宿主解析，
/// 不接受页面传入的本地路径，避免把该命令扩大成任意路径打开能力。
#[tauri::command]
fn open_download_directory(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), NativeError> {
    ensure_main_webview(webview.label())?;
    let directory = app.path().download_dir().map_err(|_| NativeError {
        code: NativeErrorCode::DownloadDirectoryUnavailable,
        message: "system download directory is unavailable".into(),
    })?;
    let directory = directory.to_str().ok_or_else(|| NativeError {
        code: NativeErrorCode::DownloadDirectoryUnavailable,
        message: "system download directory is not valid UTF-8".into(),
    })?;
    app.opener()
        .open_path(directory, None::<&str>)
        .map_err(|_| NativeError {
            code: NativeErrorCode::DownloadDirectoryUnavailable,
            message: "failed to open the system download directory".into(),
        })
}

/// 仅允许主 WebView 写入有界纯文本；不向终端内容开放剪贴板读取能力。
#[tauri::command]
fn clipboard_write(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    request: ClipboardWriteRequest,
) -> Result<(), NativeError> {
    ensure_main_webview(webview.label())?;
    validate_clipboard_text(&request.text)?;
    app.clipboard()
        .write_text(request.text)
        .map_err(|_| NativeError {
            code: NativeErrorCode::ClipboardUnavailable,
            message: "failed to write text to the system clipboard".into(),
        })
}

#[tauri::command]
async fn preview_webviews_set_theme(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, PreviewWebviewState>,
    theme: PreviewColorScheme,
) -> Result<(), NativeError> {
    ensure_main_webview(caller.label())?;
    let lifetime = state.registry.lifetime()?;
    let mut current = state.theme.lock().await;
    lifetime.check()?;
    *current = theme;
    let labels = state.registry.labels()?;
    let mut failure = None;
    for label in labels {
        lifetime.check()?;
        if let Some(preview) = app.get_webview(&label)
            && let Err(error) = preview_theme::apply(&preview, theme, &lifetime).await
        {
            // A closed/stalled tab must not prevent the remaining tabs receiving the theme.
            failure = Some(error);
        }
    }
    lifetime.check()?;
    failure.map_or(Ok(()), Err)
}

async fn finish_preview_navigation(
    preview: &tauri::Webview,
    lifetime: preview_lifecycle::Lifetime,
    url: Url,
    bounds: Rect,
) -> Result<(), NativeError> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let target = preview.clone();
    preview
        .run_on_main_thread(move || {
            // Reload cleanup also runs on this UI thread. Check here, not merely before dispatch.
            let result = lifetime.run_if_current(|| {
                target.navigate(url).map_err(|_| preview_unavailable())?;
                target
                    .set_bounds(bounds)
                    .map_err(|_| preview_unavailable())?;
                target.show().map_err(|_| preview_unavailable())
            });
            let _ = sender.try_send(result);
        })
        .map_err(|_| preview_unavailable())?;
    receiver.recv().await.ok_or_else(preview_unavailable)?
}

fn discard_preview(preview: &tauri::Webview, state: &PreviewWebviewState) {
    if preview.close().is_ok() {
        let _ = state.unregister(preview.label());
    } else {
        // A reload may already have drained the registry; retain failed cleanup for a later retry.
        state.restore([preview.label().to_owned()]);
    }
}

#[tauri::command]
async fn preview_webview_open(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, PreviewWebviewState>,
    request: PreviewWebviewOpenRequest,
) -> Result<(), NativeError> {
    ensure_main_webview(caller.label())?;
    let label = validate_preview_id(&request.id)?;
    let url = validate_preview_url(&request.url)?;
    let bounds = validate_preview_bounds(request.bounds)?;
    let lifetime = state.registry.lifetime()?;
    let theme = state.theme.lock().await;
    lifetime.check()?;

    if let Some(existing) = app.get_webview(&label) {
        let reuse = existing
            .url()
            .is_ok_and(|current| same_origin(&current, &url));
        if reuse {
            preview_lifecycle::prepare_navigation(
                &lifetime,
                preview_theme::apply(&existing, *theme, &lifetime),
            )
            .await?;
            return finish_preview_navigation(&existing, lifetime, url, bounds).await;
        }
        existing.close().map_err(|_| preview_unavailable())?;
    }

    let allowed_origin = url.clone();
    // Set the renderer preference before the first application script reads matchMedia.
    let blank = Url::parse("about:blank").expect("static blank URL is valid");
    let builder = WebviewBuilder::new(label, WebviewUrl::External(blank))
        .incognito(true)
        .devtools(cfg!(debug_assertions))
        .initialization_script_for_all_frames(PREVIEW_PERMISSION_GUARD)
        .on_navigation(move |candidate| {
            candidate.as_str() == "about:blank" || same_origin(candidate, &allowed_origin)
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false);
    let preview = caller
        .window()
        .add_child(builder, bounds.position, bounds.size)
        .map_err(|_| preview_unavailable())?;
    let initialized = async {
        state
            .registry
            .register(preview.label().to_owned(), &lifetime)?;
        preview.hide().map_err(|_| preview_unavailable())?;
        preview_lifecycle::prepare_navigation(
            &lifetime,
            preview_theme::apply(&preview, *theme, &lifetime),
        )
        .await?;
        finish_preview_navigation(&preview, lifetime, url, bounds).await
    }
    .await;
    if let Err(error) = initialized {
        discard_preview(&preview, &state);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
async fn preview_webview_set_bounds(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    request: PreviewWebviewBoundsRequest,
) -> Result<(), NativeError> {
    ensure_main_webview(caller.label())?;
    let label = validate_preview_id(&request.id)?;
    let bounds = validate_preview_bounds(request.bounds)?;
    if let Some(preview) = app.get_webview(&label) {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        let target = preview.clone();
        // On the UI thread set_bounds dispatches synchronously. Acknowledging only after this
        // closure prevents the frontend from restoring a child whose geometry is still queued.
        // This confirms geometry application, not WebView2 compositor/paint completion.
        preview
            .run_on_main_thread(move || {
                let result = target.set_bounds(bounds).map_err(|_| preview_unavailable());
                let _ = sender.try_send(result);
            })
            .map_err(|_| preview_unavailable())?;
        receiver.recv().await.ok_or_else(preview_unavailable)??;
    }
    Ok(())
}

#[tauri::command]
async fn preview_webview_capture(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    request: PreviewWebviewCaptureRequest,
) -> Result<PreviewWebviewSnapshot, NativeError> {
    ensure_main_webview(caller.label())?;
    let label = validate_preview_id(&request.id)?;
    let preview = app.get_webview(&label).ok_or_else(preview_unavailable)?;
    Ok(PreviewWebviewSnapshot {
        data_url: preview_snapshot::capture(&preview).await,
    })
}

#[tauri::command]
async fn preview_webview_set_visible(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    request: PreviewWebviewVisibilityRequest,
) -> Result<(), NativeError> {
    ensure_main_webview(caller.label())?;
    let label = validate_preview_id(&request.id)?;
    if let Some(preview) = app.get_webview(&label) {
        let result = if request.visible {
            preview.show()
        } else {
            preview.hide()
        };
        result.map_err(|_| preview_unavailable())?;
    }
    Ok(())
}

#[tauri::command]
async fn preview_webview_close(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, PreviewWebviewState>,
    request: PreviewWebviewCloseRequest,
) -> Result<(), NativeError> {
    ensure_main_webview(caller.label())?;
    let label = validate_preview_id(&request.id)?;
    if let Some(preview) = app.get_webview(&label) {
        preview.close().map_err(|_| preview_unavailable())?;
    }
    state.unregister(&label)?;
    Ok(())
}

#[tauri::command]
fn desktop_update_current_version(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<String, NativeError> {
    ensure_main_webview(webview.label())?;
    Ok(app.package_info().version.to_string())
}

#[tauri::command]
async fn desktop_update_check(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopUpdateState>,
) -> Result<Option<DesktopUpdateInfo>, NativeError> {
    ensure_main_webview(webview.label())?;
    let update_target = current_desktop_update_target()?;
    let _busy = begin_update_operation(&state)?;
    let public_key = UPDATER_PUBLIC_KEY
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .ok_or_else(|| {
            update_error(
                NativeErrorCode::UpdateCheckFailed,
                "desktop updater is not configured in this build",
            )
        })?;
    let endpoint = Url::parse(DESKTOP_UPDATE_ENDPOINT).map_err(|_| {
        update_error(
            NativeErrorCode::UpdateCheckFailed,
            "desktop update endpoint is invalid",
        )
    })?;
    let updater = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|_| {
            update_error(
                NativeErrorCode::UpdateCheckFailed,
                "desktop updater configuration is invalid",
            )
        })?
        .build()
        .map_err(|_| {
            update_error(
                NativeErrorCode::UpdateCheckFailed,
                "desktop updater is unavailable",
            )
        })?;
    let update = updater.check().await.map_err(|_| {
        update_error(
            NativeErrorCode::UpdateCheckFailed,
            "failed to check for desktop updates",
        )
    })?;
    if let Some(update) = &update
        && update.download_url != expected_desktop_update_url(update_target, &update.version)?
    {
        return Err(update_error(
            NativeErrorCode::UpdateCheckFailed,
            "desktop update artifact URL is not allowed",
        ));
    }
    let info = update.as_ref().map(|update| DesktopUpdateInfo {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        notes: update.body.clone(),
        published_at: update.date.map(|date| date.to_string()),
    });
    *state.pending.lock().map_err(|_| {
        update_error(
            NativeErrorCode::UpdateCheckFailed,
            "desktop update state is unavailable",
        )
    })? = update;
    Ok(info)
}

#[tauri::command]
async fn desktop_update_install(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopUpdateState>,
    on_event: Channel<DesktopUpdateProgress>,
) -> Result<(), NativeError> {
    ensure_main_webview(webview.label())?;
    current_desktop_update_target()?;
    let _busy = begin_update_operation(&state)?;
    let update = state
        .pending
        .lock()
        .map_err(|_| {
            update_error(
                NativeErrorCode::UpdateInstallFailed,
                "desktop update state is unavailable",
            )
        })?
        .take()
        .ok_or_else(|| {
            update_error(
                NativeErrorCode::NoPendingUpdate,
                "there is no pending desktop update",
            )
        })?;
    let mut started = false;
    let install_result = update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    let _ = on_event.send(DesktopUpdateProgress::Started {
                        content_length: content_length.map(|length| length as f64),
                    });
                    started = true;
                }
                let _ = on_event.send(DesktopUpdateProgress::Progress {
                    chunk_length: chunk_length as f64,
                });
            },
            || {
                let _ = on_event.send(DesktopUpdateProgress::Downloaded);
                let _ = on_event.send(DesktopUpdateProgress::Installing);
            },
        )
        .await;
    if install_result.is_err() {
        *state.pending.lock().map_err(|_| {
            update_error(
                NativeErrorCode::UpdateInstallFailed,
                "desktop update state is unavailable",
            )
        })? = Some(update);
        return Err(update_error(
            NativeErrorCode::UpdateInstallFailed,
            "failed to download or install the desktop update",
        ));
    }
    app.restart();
}

fn dispatch_deep_link(app: &tauri::AppHandle, value: &str, retain_pending: bool) {
    let Ok(url) = validate_desktop_oauth_callback(value) else {
        return;
    };
    let url = url.to_string();
    let state = app.state::<DeepLinkState>();
    let Ok(mut state) = state.inner.lock() else {
        return;
    };
    if state.last_dispatched.as_deref() == Some(&url) {
        return;
    }
    state.last_dispatched = Some(url.clone());
    if retain_pending {
        state.pending = Some(url.clone());
    }
    drop(state);

    let _ = app.emit_to("main", DEEP_LINK_EVENT, DeepLinkPayload { url });
}

fn dispatch_deep_links<'a>(
    app: &tauri::AppHandle,
    values: impl IntoIterator<Item = &'a str>,
    retain_pending: bool,
) {
    for value in values {
        dispatch_deep_link(app, value, retain_pending);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // 必须最先注册，确保第二次启动的参数转发给现有实例。
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let pending = desktop_startup_pending(app);
            dispatch_deep_links(app, args.iter().map(String::as_str), pending);
            restore_main_window(app);
        }))
        .manage(DeepLinkState::default())
        .manage(PreviewWebviewState::default())
        .manage(DesktopUpdateState::default())
        .manage(DesktopLifecycleState::default())
        .manage(NativeConnectorState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            desktop_startup_ready,
            take_pending_desktop_exit,
            desktop_restore,
            desktop_exit,
            open_external,
            open_download_directory,
            clipboard_write,
            secure_storage_get,
            secure_storage_set,
            secure_storage_remove,
            take_pending_deep_link,
            preview_webview_open,
            preview_webviews_set_theme,
            preview_webview_set_bounds,
            preview_webview_set_visible,
            preview_webview_capture,
            preview_webview_close,
            desktop_update_current_version,
            desktop_update_check,
            desktop_update_install,
            native_connector_path
        ])
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == PageLoadEvent::Started {
                close_registered_previews(webview.app_handle());
            }
        });
    #[cfg(target_os = "windows")]
    let builder = builder.manage(window_startup::State::default());
    let app = builder
        .setup(|app| {
            #[cfg(target_os = "windows")]
            window_startup::prepare(app.handle());
            desktop_tray::install(app)?;
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            match prepare_native_connector(app.handle()) {
                Ok(path) => {
                    if let Ok(mut state) = app.state::<NativeConnectorState>().path.lock() {
                        *state = Some(path);
                    }
                }
                Err(error) => eprintln!("native connector is unavailable: {error}"),
            }
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                dispatch_deep_links(
                    &app_handle,
                    event.urls().iter().map(|url| url.as_str()),
                    desktop_startup_pending(&app_handle),
                );
            });

            dispatch_deep_links(
                app.handle(),
                std::env::args()
                    .skip(1)
                    .collect::<Vec<_>>()
                    .iter()
                    .map(String::as_str),
                true,
            );
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                dispatch_deep_links(app.handle(), urls.iter().map(|url| url.as_str()), true);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build desktop");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } => {
            api.prevent_exit();
            request_desktop_exit(app);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => restore_main_window(app),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_commands_only_accept_the_main_webview() {
        assert!(ensure_main_webview("main").is_ok());
        let error = ensure_main_webview("preview-tab").unwrap_err();
        assert_eq!(error.code, NativeErrorCode::InvalidCaller);
    }

    #[test]
    fn desktop_exit_requests_are_consumed_once() {
        let state = DesktopLifecycleState::default();
        assert!(!state.take_exit());
        state.request_exit();
        state.request_exit();
        assert!(state.take_exit());
        assert!(!state.take_exit());
    }

    #[cfg(unix)]
    #[test]
    fn native_connector_install_is_atomic_and_executable() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "renrencodex-native-connector-test-{}-{unique}",
            std::process::id()
        ));
        let source = root.join("source");
        let destination = root.join("data/bin/renrencodex-connect");
        fs::create_dir_all(&root).unwrap();
        fs::write(&source, b"connector-v1").unwrap();

        install_native_connector(&source, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"connector-v1");
        assert_eq!(
            destination.metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );

        fs::write(&source, b"connector-v2").unwrap();
        install_native_connector(&source, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"connector-v2");
        assert_eq!(
            fs::read_dir(destination.parent().unwrap()).unwrap().count(),
            1
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn preview_inputs_are_restricted_to_platform_hosts_and_sane_bounds() {
        assert!(
            validate_preview_url("https://80-machine.preview.renrencodex.com/?token=secret")
                .is_ok()
        );
        assert!(validate_preview_url("https://preview.renrencodex.com").is_err());
        assert!(validate_preview_url("https://preview.renrencodex.com.evil.example").is_err());
        assert!(validate_preview_url("https://user@80-machine.preview.renrencodex.com").is_err());
        assert!(validate_preview_id("tab_1234-abcd").is_ok());
        assert!(validate_preview_id("../main").is_err());
        assert!(
            validate_preview_bounds(PreviewWebviewBounds {
                x: 10.0,
                y: 20.0,
                width: 800.0,
                height: 600.0,
            })
            .is_ok()
        );
        assert!(
            validate_preview_bounds(PreviewWebviewBounds {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 600.0,
            })
            .is_err()
        );
    }

    #[test]
    fn preview_registry_drains_every_registered_native_label() {
        let state = PreviewWebviewState::default();
        let lifetime = state.registry.lifetime().unwrap();
        state
            .registry
            .register("preview-first".into(), &lifetime)
            .unwrap();
        state
            .registry
            .register("preview-second".into(), &lifetime)
            .unwrap();
        state
            .registry
            .register("preview-first".into(), &lifetime)
            .unwrap();
        let mut labels = state.take_all().unwrap();
        labels.sort();
        assert_eq!(labels, ["preview-first", "preview-second"]);
        assert!(state.take_all().unwrap().is_empty());
    }

    #[test]
    fn preview_permission_guard_covers_sensitive_browser_apis() {
        for api in [
            "getUserMedia",
            "getDisplayMedia",
            "geolocation",
            "clipboard",
            "requestDevice",
            "requestPort",
            "requestMIDIAccess",
            "requestFullscreen",
        ] {
            assert!(PREVIEW_PERMISSION_GUARD.contains(api), "missing {api}");
        }
    }

    #[test]
    fn keyring_entry_rejects_every_other_key_before_backend_access() {
        let error = keyring_entry("other-secret").unwrap_err();
        assert_eq!(error.code, NativeErrorCode::InvalidStorageKey);
        assert!(!error.message.contains("other-secret"));
    }

    #[test]
    fn update_operations_are_serialized_and_release_the_lock_on_drop() {
        let state = DesktopUpdateState::default();
        let guard = begin_update_operation(&state).unwrap();
        let error = begin_update_operation(&state).unwrap_err();
        assert_eq!(error.code, NativeErrorCode::UpdateBusy);
        drop(guard);
        assert!(begin_update_operation(&state).is_ok());
    }

    #[test]
    fn desktop_update_targets_are_explicit_and_linux_requires_appimage() {
        assert_eq!(
            desktop_update_target("windows", "x86_64", false),
            Some(DesktopUpdateTarget::WindowsX86_64)
        );
        assert_eq!(
            desktop_update_target("macos", "aarch64", false),
            Some(DesktopUpdateTarget::MacosUniversal)
        );
        assert_eq!(
            desktop_update_target("macos", "x86_64", false),
            Some(DesktopUpdateTarget::MacosUniversal)
        );
        assert_eq!(desktop_update_target("linux", "x86_64", false), None);
        assert_eq!(
            desktop_update_target("linux", "x86_64", true),
            Some(DesktopUpdateTarget::LinuxX86_64)
        );
        assert_eq!(desktop_update_target("windows", "aarch64", false), None);
    }

    #[test]
    fn update_artifacts_are_pinned_to_versioned_platform_origins() {
        assert_eq!(
            expected_desktop_update_url(DesktopUpdateTarget::WindowsX86_64, "0.1.0")
                .unwrap()
                .as_str(),
            "https://renrencodex.com/downloads/desktop/stable/windows-x86_64/renrencodex-desktop-0.1.0-x64.msi"
        );
        assert_eq!(
            expected_desktop_update_url(DesktopUpdateTarget::MacosUniversal, "0.1.0")
                .unwrap()
                .as_str(),
            "https://renrencodex.com/downloads/desktop/stable/macos-universal/renrencodex-desktop-0.1.0-universal.app.tar.gz"
        );
        assert_eq!(
            expected_desktop_update_url(DesktopUpdateTarget::LinuxX86_64, "0.1.0")
                .unwrap()
                .as_str(),
            "https://renrencodex.com/downloads/desktop/stable/linux-x86_64/renrencodex-desktop-0.1.0-x86_64.AppImage"
        );
    }
}
