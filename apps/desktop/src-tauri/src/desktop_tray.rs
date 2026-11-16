use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const TRAY_ID: &str = "renrencodex-main";
const OPEN_MENU_ID: &str = "tray-open-main";
const EXIT_MENU_ID: &str = "tray-exit-app";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MenuAction {
    Open,
    Exit,
}

fn menu_action(id: &str) -> Option<MenuAction> {
    match id {
        OPEN_MENU_ID => Some(MenuAction::Open),
        EXIT_MENU_ID => Some(MenuAction::Exit),
        _ => None,
    }
}

fn is_restore_activation(button: MouseButton, button_state: Option<MouseButtonState>) -> bool {
    button == MouseButton::Left && button_state.is_none_or(|state| state == MouseButtonState::Up)
}

fn should_restore(event: &TrayIconEvent) -> bool {
    match event {
        TrayIconEvent::Click {
            button,
            button_state,
            ..
        } => is_restore_activation(*button, Some(*button_state)),
        TrayIconEvent::DoubleClick { button, .. } => is_restore_activation(*button, None),
        _ => false,
    }
}

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_MENU_ID, "打开人人Codex", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, EXIT_MENU_ID, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &exit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("人人Codex")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match menu_action(event.id().as_ref()) {
            Some(MenuAction::Open) => super::restore_main_window(app),
            Some(MenuAction::Exit) => super::request_desktop_exit(app),
            None => {}
        })
        .on_tray_icon_event(|tray, event| {
            if should_restore(&event) {
                super::restore_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_only_known_tray_menu_items() {
        assert_eq!(menu_action(OPEN_MENU_ID), Some(MenuAction::Open));
        assert_eq!(menu_action(EXIT_MENU_ID), Some(MenuAction::Exit));
        assert_eq!(menu_action("another-menu"), None);
    }

    #[test]
    fn restores_only_for_completed_left_clicks_or_double_clicks() {
        assert!(is_restore_activation(
            MouseButton::Left,
            Some(MouseButtonState::Up)
        ));
        assert!(!is_restore_activation(
            MouseButton::Left,
            Some(MouseButtonState::Down)
        ));
        assert!(!is_restore_activation(
            MouseButton::Right,
            Some(MouseButtonState::Up)
        ));
        assert!(is_restore_activation(MouseButton::Left, None));
        assert!(!is_restore_activation(MouseButton::Right, None));
    }
}
