// Windows startup is prepared behind a DWM cloak. Merely setting visible=false
// with maximized=true is insufficient: Tao calls SW_MAXIMIZE before SW_HIDE.
// Keep the lifecycle testable without requiring a Windows compositor.
use std::{collections::VecDeque, sync::Mutex, time::Duration};

trait StartupWindow {
    fn cloak(&self, enabled: bool) -> Result<(), String>;
    fn transitions_disabled(&self, disabled: bool);
    fn is_enabled(&self) -> Result<bool, String>;
    fn set_enabled(&self, enabled: bool) -> Result<(), String>;
    fn maximize(&self) -> Result<(), String>;
    fn show(&self) -> Result<(), String>;
    fn focus(&self);
}

// DWM cloaking only controls presentation, not activation. A disabled HWND
// cannot be activated by Tao's SW_MAXIMIZE / SW_SHOW. Guard EACH call: Tao may
// rewrite WS_DISABLED when updating window styles, so disabling once around
// both calls would still allow the second operation to steal focus.
// https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enablewindow
fn without_activation(
    window: &impl StartupWindow,
    operation: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let enabled = window.is_enabled()?;
    window.set_enabled(false)?;
    let result = operation();
    // Restore even when the operation failed; do not leave an inert window.
    let restore = window.set_enabled(enabled);
    match (result, restore) {
        (Err(operation), Err(restore)) => Err(format!("{operation}; restore enabled: {restore}")),
        (result, restore) => result.and(restore),
    }
}

const MAX_REVEAL_ATTEMPTS: u8 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RevealRequest {
    Ready,
    Retry(u64),
    Recover,
}

#[derive(Clone, Copy, Debug)]
struct Retry {
    id: u64,
    delay: Duration,
}

#[derive(Clone, Default)]
struct Startup {
    prepared: bool,
    cloaked: bool,
    maximized: bool,
    released: bool,
    attempts: u8,
    retry_id: u64,
    pending_retry: Option<u64>,
}

impl Startup {
    fn prepare(&mut self, window: &impl StartupWindow) {
        if self.prepared || self.released {
            return;
        }
        self.prepared = true;
        window.transitions_disabled(true);
        match window.cloak(true) {
            Ok(()) => {
                self.cloaked = true;
                // Maximizing may also make the native window visible. Only do
                // this early when the compositor has acknowledged the cloak.
                self.maximize(window);
                if let Err(error) = without_activation(window, || window.show()) {
                    eprintln!("Desktop startup preparation: {error}");
                }
            }
            Err(error) => {
                // DWM unavailable: stay hidden until ready and then show with
                // transitions disabled. Never hide the app indefinitely.
                eprintln!("Desktop startup cloak unavailable: {error}");
            }
        }
    }

    fn maximize(&mut self, window: &impl StartupWindow) {
        match without_activation(window, || window.maximize()) {
            Ok(()) => self.maximized = true,
            Err(error) => eprintln!("Desktop startup maximize: {error}"),
        }
    }

    fn reveal(&mut self, window: &impl StartupWindow) -> Result<(), String> {
        if self.released {
            return Ok(());
        }
        if !self.maximized {
            // Even when the OS rejects maximize, a usable restored window is
            // preferable to an app that remains hidden.
            self.maximize(window);
        }
        without_activation(window, || window.show())?;
        if self.cloaked {
            window.cloak(false)?;
            self.cloaked = false;
        }
        self.released = true;
        window.transitions_disabled(false);
        window.focus();
        Ok(())
    }

    fn request_reveal(
        &mut self,
        window: &impl StartupWindow,
        request: RevealRequest,
    ) -> Option<Retry> {
        if self.released {
            return None;
        }
        match request {
            // UI ready and the independent fallback share one bounded retry
            // budget. Duplicate IPC / reloads cannot create additional loops.
            RevealRequest::Ready if self.attempts != 0 => return None,
            RevealRequest::Retry(id) if self.pending_retry != Some(id) => return None,
            // A second launch must not reveal a normally loading window early.
            RevealRequest::Recover if self.attempts == 0 => return None,
            RevealRequest::Recover => self.attempts = 0,
            _ => {}
        }
        self.pending_retry = None;
        self.attempts += 1;
        if let Err(error) = self.reveal(window) {
            eprintln!(
                "Desktop startup reveal (attempt {}): {error}",
                self.attempts
            );
            if self.attempts < MAX_REVEAL_ATTEMPTS {
                self.retry_id = self.retry_id.wrapping_add(1);
                self.pending_retry = Some(self.retry_id);
                return Some(Retry {
                    id: self.retry_id,
                    delay: Duration::from_millis(250 * (1 << (self.attempts - 1))),
                });
            }
            eprintln!("Desktop startup retries exhausted; open the app again to retry");
        }
        None
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Request {
    Prepare,
    Reveal(RevealRequest),
}

#[derive(Default)]
struct Driver {
    startup: Startup,
    in_flight: bool,
    drain_scheduled: bool,
    requests: VecDeque<Request>,
}

#[derive(Default)]
struct DispatchResult {
    retry: Option<Retry>,
    drain: bool,
}

#[derive(Default)]
pub(crate) struct State(Mutex<Driver>);

impl State {
    fn is_pending(&self) -> bool {
        // Published only after ALL window calls have returned, including focus.
        // A second launch nested inside those calls must remain a startup
        // request, not take the normal show/focus path.
        !self
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .startup
            .released
    }

    fn drain_failed(&self) {
        // Keep the requests, but do not wait forever for a task that was never
        // posted. A later readiness/activation request may resume the queue.
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain_scheduled = false;
    }

    /// Execute at most one request on the event-loop thread. `None` drains a
    /// previously scheduled request, rather than submitting another one.
    fn dispatch(&self, window: &impl StartupWindow, request: Option<Request>) -> DispatchResult {
        let (mut startup, request) = {
            let mut driver = self.0.lock().unwrap_or_else(|error| error.into_inner());
            if driver.startup.released {
                return DispatchResult::default();
            }
            if let Some(request) = request {
                // A burst of readiness/activation messages must not recursively
                // execute, or grow a queue of identical recovery attempts.
                if !driver.requests.contains(&request) {
                    driver.requests.push_back(request);
                }
            } else {
                driver.drain_scheduled = false;
            }
            if driver.in_flight || driver.drain_scheduled {
                return DispatchResult::default();
            }
            let Some(request) = driver.requests.pop_front() else {
                return DispatchResult::default();
            };
            driver.in_flight = true;
            (driver.startup.clone(), request)
        };

        // No state guard survives this boundary. ShowWindow, DWM and WebView2
        // calls may pump nested Win32 messages on this very same UI thread.
        let retry = match request {
            Request::Prepare => {
                startup.prepare(window);
                None
            }
            Request::Reveal(request) => startup.request_reveal(window, request),
        };

        let mut driver = self.0.lock().unwrap_or_else(|error| error.into_inner());
        driver.startup = startup;
        driver.in_flight = false;
        if driver.startup.released {
            driver.requests.clear();
        }
        let drain = !driver.requests.is_empty() && !driver.drain_scheduled;
        driver.drain_scheduled = drain;
        DispatchResult { retry, drain }
    }
}

#[cfg(target_os = "windows")]
mod native {
    use super::{Request, RevealRequest, StartupWindow, State};
    use std::time::Duration;
    use tauri::{AppHandle, Manager, WebviewWindow};
    use windows::{
        Win32::Graphics::Dwm::{
            DWMWA_CLOAK, DWMWA_TRANSITIONS_FORCEDISABLED, DWMWINDOWATTRIBUTE, DwmSetWindowAttribute,
        },
        core::BOOL,
    };

    fn attribute(
        window: &WebviewWindow,
        name: DWMWINDOWATTRIBUTE,
        value: bool,
    ) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        let value = BOOL::from(value);
        // DWM consumes a BOOL synchronously; its pointer is valid for this call.
        // https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                name,
                (&value as *const BOOL).cast(),
                std::mem::size_of::<BOOL>() as u32,
            )
        }
        .map_err(|error| error.to_string())
    }

    impl StartupWindow for WebviewWindow {
        fn cloak(&self, enabled: bool) -> Result<(), String> {
            attribute(self, DWMWA_CLOAK, enabled)
        }

        fn transitions_disabled(&self, disabled: bool) {
            if let Err(error) = attribute(self, DWMWA_TRANSITIONS_FORCEDISABLED, disabled) {
                eprintln!("Desktop startup transitions: {error}");
            }
        }

        fn is_enabled(&self) -> Result<bool, String> {
            self.is_enabled().map_err(|error| error.to_string())
        }

        fn set_enabled(&self, enabled: bool) -> Result<(), String> {
            self.set_enabled(enabled).map_err(|error| error.to_string())
        }

        fn maximize(&self) -> Result<(), String> {
            self.maximize().map_err(|error| error.to_string())
        }

        fn show(&self) -> Result<(), String> {
            self.show().map_err(|error| error.to_string())
        }

        fn focus(&self) {
            if let Err(error) = self.set_focus() {
                eprintln!("Desktop startup focus: {error}");
            }
        }
    }

    pub(crate) fn is_pending(app: &AppHandle) -> bool {
        app.try_state::<State>()
            .is_none_or(|state| state.is_pending())
    }

    // Window mutations stay on the UI thread; State also handles SAME-thread
    // reentrancy, which run_on_main_thread alone does not prevent.
    fn process(app: &AppHandle, request: Option<Request>) {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let result = app.state::<State>().dispatch(&window, request);
        if let Some(retry) = result.retry {
            let handle = app.clone();
            if let Err(error) = std::thread::Builder::new()
                .name("desktop-startup-retry".into())
                .spawn(move || {
                    std::thread::sleep(retry.delay);
                    dispatch(
                        &handle,
                        Some(Request::Reveal(RevealRequest::Retry(retry.id))),
                    );
                })
            {
                eprintln!("Desktop startup retry timer: {error}");
            }
        }
        if result.drain {
            let handle = app.clone();
            // Calling run_on_main_thread here would execute inline. Post from
            // the runtime worker so recovery runs after this operation, without
            // a recursive window call stack or a synchronous queue-drain loop.
            tauri::async_runtime::spawn(async move {
                dispatch(&handle, None);
            });
        }
    }

    fn dispatch(app: &AppHandle, request: Option<Request>) {
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || process(&handle, request)) {
            if request.is_none()
                && let Some(state) = app.try_state::<State>()
            {
                state.drain_failed();
            }
            eprintln!("Desktop startup dispatch: {error}");
        }
    }

    pub(crate) fn ready(app: &AppHandle) {
        dispatch(app, Some(Request::Reveal(RevealRequest::Ready)));
    }

    pub(crate) fn recover(app: &AppHandle) {
        dispatch(app, Some(Request::Reveal(RevealRequest::Recover)));
    }

    pub(crate) fn prepare(app: &AppHandle) {
        process(app, Some(Request::Prepare));
        // Independent of JavaScript, animation frames, fonts and network. A
        // broken frontend must not leave the native window permanently hidden.
        let handle = app.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("desktop-startup-fallback".into())
            .spawn(move || {
                std::thread::sleep(Duration::from_secs(5));
                ready(&handle);
            })
        {
            eprintln!("Desktop startup fallback: {error}");
            process(app, Some(Request::Reveal(RevealRequest::Ready)));
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) use native::{is_pending, prepare, ready, recover};

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };

    type WindowHook = Box<dyn Fn(&Window, &'static str)>;

    struct Window {
        events: RefCell<Vec<&'static str>>,
        enabled_changes: RefCell<Vec<bool>>,
        enabled: Cell<bool>,
        early_activations: Cell<u8>,
        fail_disable: Cell<bool>,
        fail_cloak: Cell<bool>,
        fail_uncloak: Cell<bool>,
        fail_maximize: Cell<bool>,
        fail_show: Cell<bool>,
        on_call: Option<WindowHook>,
    }

    impl Default for Window {
        fn default() -> Self {
            Self {
                events: RefCell::default(),
                enabled_changes: RefCell::default(),
                enabled: Cell::new(true),
                early_activations: Cell::default(),
                fail_disable: Cell::default(),
                fail_cloak: Cell::default(),
                fail_uncloak: Cell::default(),
                fail_maximize: Cell::default(),
                fail_show: Cell::default(),
                on_call: None,
            }
        }
    }

    impl Window {
        fn notify(&self, event: &'static str) {
            if let Some(hook) = &self.on_call {
                hook(self, event);
            }
        }

        fn record(&self, event: &'static str) {
            self.events.borrow_mut().push(event);
            self.notify(event);
        }

        fn tao_window_operation(&self) {
            if self.enabled.get() {
                self.early_activations.set(self.early_activations.get() + 1);
            }
            // Model Tao rewriting WS_DISABLED after its activating ShowWindow
            // calls. The next operation must acquire its own guard.
            self.enabled.set(true);
        }
    }

    impl StartupWindow for Window {
        fn cloak(&self, enabled: bool) -> Result<(), String> {
            self.record(if enabled { "cloak" } else { "uncloak" });
            if (enabled && self.fail_cloak.get()) || (!enabled && self.fail_uncloak.get()) {
                Err("DWM unavailable".into())
            } else {
                Ok(())
            }
        }
        fn transitions_disabled(&self, disabled: bool) {
            self.record(if disabled {
                "disable-transitions"
            } else {
                "restore-transitions"
            });
        }
        fn is_enabled(&self) -> Result<bool, String> {
            self.notify("is-enabled");
            Ok(self.enabled.get())
        }
        fn set_enabled(&self, enabled: bool) -> Result<(), String> {
            self.enabled_changes.borrow_mut().push(enabled);
            self.notify(if enabled { "enable" } else { "disable" });
            if !enabled && self.fail_disable.get() {
                return Err("disable failed".into());
            }
            self.enabled.set(enabled);
            Ok(())
        }
        fn maximize(&self) -> Result<(), String> {
            self.tao_window_operation();
            self.record("maximize");
            if self.fail_maximize.get() {
                Err("maximize failed".into())
            } else {
                Ok(())
            }
        }
        fn show(&self) -> Result<(), String> {
            self.tao_window_operation();
            self.record("show");
            if self.fail_show.get() {
                Err("show failed".into())
            } else {
                Ok(())
            }
        }
        fn focus(&self) {
            assert!(self.enabled.get(), "revealed window must accept input");
            self.record("focus");
        }
    }

    fn assert_idle(result: DispatchResult) {
        assert!(result.retry.is_none());
        assert!(!result.drain);
    }

    #[test]
    fn native_operations_never_hold_the_state_lock_during_callbacks() {
        let state = Rc::new(State::default());
        let callbacks = Rc::new(Cell::new(0));
        let window = Window {
            on_call: Some(Box::new({
                let state = state.clone();
                let callbacks = callbacks.clone();
                move |_, event| {
                    // This was the failing review probe: the old native wrapper
                    // held the mutex across every window operation.
                    assert!(state.0.try_lock().is_ok(), "lock held during {event}");
                    assert!(state.is_pending(), "published before {event} returned");
                    callbacks.set(callbacks.get() + 1);
                }
            })),
            ..Window::default()
        };
        assert_idle(state.dispatch(&window, Some(Request::Prepare)));
        assert_idle(state.dispatch(&window, Some(Request::Reveal(RevealRequest::Ready))));
        assert!(!state.is_pending());
        assert!(callbacks.get() > 0);
        assert_eq!(window.early_activations.get(), 0);
    }

    #[test]
    fn reentrant_readiness_waits_until_prepare_returns_and_coalesces_requests() {
        let state = Rc::new(State::default());
        let window = Window {
            on_call: Some(Box::new({
                let state = state.clone();
                move |window, event| {
                    if event != "maximize" {
                        return;
                    }
                    assert!(state.is_pending());
                    let events = window.events.borrow().len();
                    for _ in 0..10 {
                        assert_idle(
                            state.dispatch(window, Some(Request::Reveal(RevealRequest::Ready))),
                        );
                        assert_idle(
                            state.dispatch(window, Some(Request::Reveal(RevealRequest::Recover))),
                        );
                    }
                    // Even a queued task pumped by Windows cannot drain while
                    // the outer native operation is in flight.
                    assert_idle(state.dispatch(window, None));
                    assert_eq!(state.0.lock().unwrap().requests.len(), 2);
                    assert_eq!(window.events.borrow().len(), events);
                }
            })),
            ..Window::default()
        };
        let prepared = state.dispatch(&window, Some(Request::Prepare));
        assert!(prepared.drain);
        assert!(prepared.retry.is_none());
        assert_eq!(
            *window.events.borrow(),
            ["disable-transitions", "cloak", "maximize", "show"]
        );
        assert!(state.is_pending());
        // A new IPC before the scheduled drain must not overtake queued work
        // or create another drain task.
        assert_idle(state.dispatch(&window, Some(Request::Reveal(RevealRequest::Ready))));
        assert_eq!(window.events.borrow().len(), 4);
        assert_idle(state.dispatch(&window, None));
        assert!(!state.is_pending());
        assert_eq!(
            window
                .events
                .borrow()
                .iter()
                .filter(|event| **event == "focus")
                .count(),
            1
        );
        let events = window.events.borrow().len();
        assert_idle(state.dispatch(&window, None));
        assert_eq!(window.events.borrow().len(), events);
    }

    #[test]
    fn reentrant_second_launch_during_prepare_does_not_bypass_readiness() {
        let state = Rc::new(State::default());
        let window = Window {
            on_call: Some(Box::new({
                let state = state.clone();
                move |window, event| {
                    if event == "show" {
                        assert_idle(
                            state.dispatch(window, Some(Request::Reveal(RevealRequest::Recover))),
                        );
                    }
                }
            })),
            ..Window::default()
        };
        assert!(state.dispatch(&window, Some(Request::Prepare)).drain);
        window.events.borrow_mut().clear();
        assert_idle(state.dispatch(&window, None));
        assert!(state.is_pending());
        assert!(window.events.borrow().is_empty());
        assert_idle(state.dispatch(&window, Some(Request::Reveal(RevealRequest::Ready))));
        assert!(!state.is_pending());
        assert_eq!(
            *window.events.borrow(),
            ["show", "uncloak", "restore-transitions", "focus"]
        );
    }

    #[test]
    fn reentrant_recovery_runs_later_and_invalidates_the_original_retry() {
        let state = Rc::new(State::default());
        let once = Cell::new(false);
        let window = Window {
            on_call: Some(Box::new({
                let state = state.clone();
                move |window, event| {
                    if event == "uncloak" && !once.replace(true) {
                        assert_idle(
                            state.dispatch(window, Some(Request::Reveal(RevealRequest::Recover))),
                        );
                        assert_idle(
                            state.dispatch(window, Some(Request::Reveal(RevealRequest::Recover))),
                        );
                        assert_idle(
                            state.dispatch(window, Some(Request::Reveal(RevealRequest::Ready))),
                        );
                    }
                }
            })),
            ..Window::default()
        };
        assert_idle(state.dispatch(&window, Some(Request::Prepare)));
        window.fail_uncloak.set(true);
        let failed = state.dispatch(&window, Some(Request::Reveal(RevealRequest::Ready)));
        let old = failed.retry.unwrap();
        assert!(failed.drain);
        assert!(state.is_pending());
        window.events.borrow_mut().clear();
        let recovered = state.dispatch(&window, None);
        let current = recovered.retry.unwrap();
        assert_ne!(old.id, current.id);
        assert!(recovered.drain);
        // The queued duplicate Ready cannot reset the attempt budget.
        assert_idle(state.dispatch(&window, None));
        assert_eq!(state.0.lock().unwrap().startup.attempts, 1);
        window.events.borrow_mut().clear();
        assert_idle(state.dispatch(&window, Some(Request::Reveal(RevealRequest::Retry(old.id)))));
        assert!(window.events.borrow().is_empty());
        window.fail_uncloak.set(false);
        assert_idle(state.dispatch(
            &window,
            Some(Request::Reveal(RevealRequest::Retry(current.id))),
        ));
        assert!(!state.is_pending());
        assert_eq!(
            *window.events.borrow(),
            ["show", "uncloak", "restore-transitions", "focus"]
        );
        assert_eq!(window.early_activations.get(), 0);
    }

    #[test]
    fn activation_nested_in_final_focus_is_discarded_after_success() {
        let state = Rc::new(State::default());
        let window = Window {
            on_call: Some(Box::new({
                let state = state.clone();
                move |window, event| {
                    if event == "focus" {
                        // The single-instance callback must still take its
                        // pending branch while the first reveal is returning.
                        assert!(state.is_pending());
                        assert_idle(
                            state.dispatch(window, Some(Request::Reveal(RevealRequest::Recover))),
                        );
                        assert_idle(
                            state.dispatch(window, Some(Request::Reveal(RevealRequest::Ready))),
                        );
                    }
                }
            })),
            ..Window::default()
        };
        assert_idle(state.dispatch(&window, Some(Request::Prepare)));
        assert_idle(state.dispatch(&window, Some(Request::Reveal(RevealRequest::Ready))));
        assert!(!state.is_pending());
        assert!(state.0.lock().unwrap().requests.is_empty());
        // Simulate minimizing immediately after reveal; no delayed startup
        // request may show, maximize or focus the window again.
        window.events.borrow_mut().clear();
        assert_idle(state.dispatch(&window, None));
        assert_idle(state.dispatch(&window, Some(Request::Prepare)));
        assert_idle(state.dispatch(&window, Some(Request::Reveal(RevealRequest::Ready))));
        assert_idle(state.dispatch(&window, Some(Request::Reveal(RevealRequest::Recover))));
        assert_idle(state.dispatch(&window, Some(Request::Reveal(RevealRequest::Retry(1)))));
        assert!(window.events.borrow().is_empty());
    }

    #[test]
    fn failed_drain_post_leaves_queued_work_recoverable() {
        let state = Rc::new(State::default());
        let window = Window {
            on_call: Some(Box::new({
                let state = state.clone();
                move |window, event| {
                    if event == "maximize" {
                        assert_idle(
                            state.dispatch(window, Some(Request::Reveal(RevealRequest::Ready))),
                        );
                    }
                }
            })),
            ..Window::default()
        };
        assert!(state.dispatch(&window, Some(Request::Prepare)).drain);
        // The runtime worker could not post the queued drain to the UI thread.
        state.drain_failed();
        assert!(state.is_pending());
        window.events.borrow_mut().clear();
        assert_idle(state.dispatch(&window, Some(Request::Reveal(RevealRequest::Recover))));
        assert!(!state.is_pending());
        assert_eq!(
            *window.events.borrow(),
            ["show", "uncloak", "restore-transitions", "focus"]
        );
    }

    #[test]
    fn prepares_maximized_behind_cloak_then_reveals_once() {
        let mut startup = Startup::default();
        let window = Window::default();
        startup.prepare(&window);
        assert!(!startup.released);
        assert_eq!(
            *window.events.borrow(),
            ["disable-transitions", "cloak", "maximize", "show"]
        );
        window.events.borrow_mut().clear();
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Ready)
                .is_none()
        );
        assert_eq!(
            *window.events.borrow(),
            ["show", "uncloak", "restore-transitions", "focus"]
        );
        assert!(startup.released);
        assert!(window.enabled.get());
        assert_eq!(window.early_activations.get(), 0);
        assert_eq!(
            *window.enabled_changes.borrow(),
            [false, true, false, true, false, true]
        );
        window.events.borrow_mut().clear();
        // StrictMode, page reload, late fallback, or a minimized window: none
        // may trigger another maximize/show/focus after the first reveal.
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Ready)
                .is_none()
        );
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Recover)
                .is_none()
        );
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Retry(1))
                .is_none()
        );
        startup.prepare(&window);
        assert!(window.events.borrow().is_empty());
    }

    #[test]
    fn missing_compositor_defers_maximize_until_ready_or_timeout() {
        let mut startup = Startup::default();
        let window = Window::default();
        window.fail_cloak.set(true);
        startup.prepare(&window);
        assert_eq!(*window.events.borrow(), ["disable-transitions", "cloak"]);
        window.events.borrow_mut().clear();
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Ready)
                .is_none()
        );
        assert_eq!(
            *window.events.borrow(),
            ["maximize", "show", "restore-transitions", "focus"]
        );
    }

    #[test]
    fn failed_reveal_can_retry_without_remaximizing_or_early_focus() {
        let mut startup = Startup::default();
        let window = Window::default();
        startup.prepare(&window);
        window.events.borrow_mut().clear();
        window.fail_show.set(true);
        let retry = startup
            .request_reveal(&window, RevealRequest::Ready)
            .unwrap();
        assert!(!startup.released);
        assert!(window.enabled.get());
        assert_eq!(*window.events.borrow(), ["show"]);
        window.fail_show.set(false);
        window.fail_uncloak.set(true);
        let retry = startup
            .request_reveal(&window, RevealRequest::Retry(retry.id))
            .unwrap();
        assert!(!startup.released);
        window.events.borrow_mut().clear();
        window.fail_uncloak.set(false);
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Retry(retry.id))
                .is_none()
        );
        assert!(startup.released);
        assert_eq!(window.early_activations.get(), 0);
        assert_eq!(
            *window.events.borrow(),
            ["show", "uncloak", "restore-transitions", "focus"]
        );
    }

    #[test]
    fn failed_maximize_still_reveals_a_usable_restored_window() {
        let mut startup = Startup::default();
        let window = Window::default();
        window.fail_maximize.set(true);
        startup.prepare(&window);
        window.events.borrow_mut().clear();
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Ready)
                .is_none()
        );
        assert!(startup.released);
        assert_eq!(
            *window.events.borrow(),
            [
                "maximize",
                "show",
                "uncloak",
                "restore-transitions",
                "focus"
            ]
        );
    }

    #[test]
    fn retry_budget_is_finite_and_second_launch_recovers_after_exhaustion() {
        let mut startup = Startup::default();
        let window = Window::default();
        startup.prepare(&window);
        window.fail_uncloak.set(true);
        let mut retry = startup.request_reveal(&window, RevealRequest::Ready);
        let mut delays = Vec::new();
        while let Some(next) = retry {
            delays.push(next.delay.as_millis());
            retry = startup.request_reveal(&window, RevealRequest::Retry(next.id));
        }
        assert_eq!(delays, [250, 500, 1000]);
        assert_eq!(startup.attempts, 4);
        assert!(!startup.released);
        assert!(startup.cloaked);
        assert!(startup.pending_retry.is_none());
        assert_eq!(window.early_activations.get(), 0);
        window.events.borrow_mut().clear();
        // Late native fallback / repeated UI readiness cannot restart the loop.
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Ready)
                .is_none()
        );
        assert!(window.events.borrow().is_empty());
        window.fail_uncloak.set(false);
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Recover)
                .is_none()
        );
        assert!(startup.released);
        assert_eq!(
            *window.events.borrow(),
            ["show", "uncloak", "restore-transitions", "focus"]
        );
    }

    #[test]
    fn second_launch_waits_for_first_frame_and_invalidates_outstanding_retries() {
        let mut startup = Startup::default();
        let window = Window::default();
        startup.prepare(&window);
        window.events.borrow_mut().clear();
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Recover)
                .is_none()
        );
        assert!(window.events.borrow().is_empty());
        window.fail_uncloak.set(true);
        let first = startup
            .request_reveal(&window, RevealRequest::Ready)
            .unwrap();
        let recovery = startup
            .request_reveal(&window, RevealRequest::Recover)
            .unwrap();
        assert_ne!(first.id, recovery.id);
        window.events.borrow_mut().clear();
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Ready)
                .is_none()
        );
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Retry(first.id))
                .is_none()
        );
        assert!(window.events.borrow().is_empty());
        window.fail_uncloak.set(false);
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Retry(recovery.id))
                .is_none()
        );
        assert!(startup.released);
        // Simulate the user minimizing immediately after recovery.
        window.events.borrow_mut().clear();
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Ready)
                .is_none()
        );
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Retry(recovery.id))
                .is_none()
        );
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Recover)
                .is_none()
        );
        assert!(window.events.borrow().is_empty());
    }

    #[test]
    fn activation_guard_restores_original_enabled_state_even_on_failure() {
        let window = Window::default();
        window.fail_show.set(true);
        assert!(without_activation(&window, || window.show()).is_err());
        assert!(window.enabled.get());
        window.enabled.set(false);
        assert!(without_activation(&window, || window.show()).is_err());
        assert!(!window.enabled.get());
        assert_eq!(window.early_activations.get(), 0);
        assert_eq!(
            *window.enabled_changes.borrow(),
            [false, true, false, false]
        );
    }

    #[test]
    fn failed_activation_guard_skips_unsafe_show_and_recovers_when_available() {
        let mut startup = Startup::default();
        let window = Window::default();
        window.fail_disable.set(true);
        startup.prepare(&window);
        assert_eq!(*window.events.borrow(), ["disable-transitions", "cloak"]);
        window.events.borrow_mut().clear();
        let retry = startup
            .request_reveal(&window, RevealRequest::Ready)
            .unwrap();
        assert!(window.events.borrow().is_empty());
        assert!(!startup.released);
        window.fail_disable.set(false);
        assert!(
            startup
                .request_reveal(&window, RevealRequest::Retry(retry.id))
                .is_none()
        );
        assert!(startup.released);
        assert_eq!(window.early_activations.get(), 0);
        assert_eq!(
            *window.events.borrow(),
            [
                "maximize",
                "show",
                "uncloak",
                "restore-transitions",
                "focus"
            ]
        );
    }
}
