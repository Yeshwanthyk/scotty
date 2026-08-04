//! Native application and window menus, adapted from Comet's GPUI shell.

use gpui::{App, KeyBinding, Menu, MenuItem, OsAction, SystemMenuType, Window, actions};

actions!(
    scotty,
    [
        About,
        Quit,
        Hide,
        HideOthers,
        ShowAll,
        OpenSettings,
        OpenCommandPalette,
        Minimize,
        Zoom,
        CloseWindow
    ]
);

pub fn init(cx: &mut App) {
    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &Minimize, cx| with_active_window(cx, |window| window.minimize_window()));
    cx.on_action(|_: &Zoom, cx| with_active_window(cx, |window| window.zoom_window()));
    cx.on_action(|_: &CloseWindow, cx| with_active_window(cx, |window| window.remove_window()));
    cx.on_action(|_: &OpenSettings, cx| crate::settings_window::open(cx));
    cx.on_action(|_: &OpenCommandPalette, cx| crate::open_command_palette(cx));
    if cfg!(target_os = "macos") {
        cx.bind_keys([
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("cmd-h", Hide, None),
            KeyBinding::new("alt-cmd-h", HideOthers, None),
            KeyBinding::new("cmd-,", OpenSettings, None),
            KeyBinding::new("cmd-k", OpenCommandPalette, None),
            KeyBinding::new("cmd-m", Minimize, None),
            KeyBinding::new("cmd-w", CloseWindow, None),
        ]);
    } else {
        cx.bind_keys([
            KeyBinding::new("ctrl-,", OpenSettings, None),
            KeyBinding::new("ctrl-k", OpenCommandPalette, None),
        ]);
    }
}

fn with_active_window(cx: &mut App, f: impl FnOnce(&mut Window)) {
    if let Some(window) = cx.active_window() {
        window.update(cx, |_, window, _| f(window)).ok();
    }
}

pub fn app_menus() -> Vec<Menu> {
    let mut app_items = vec![
        MenuItem::action("About Scotty", About).disabled(true),
        MenuItem::separator(),
        MenuItem::action("Settings…", OpenSettings),
        MenuItem::action("Command Palette…", OpenCommandPalette),
        MenuItem::separator(),
    ];
    if cfg!(target_os = "macos") {
        app_items.extend([
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("Hide Scotty", Hide),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
        ]);
    }
    app_items.push(MenuItem::action("Quit Scotty", Quit));

    let mut menus = vec![
        Menu::new("Scotty").items(app_items),
        // Route native clipboard selectors through the focused GPUI input.
        // The composer's Copy action falls back to Scotty's settled transcript
        // selection when the draft itself has no selection.
        Menu::new("Edit").items([
            MenuItem::action("Undo", crate::composer_input::Undo),
            MenuItem::action("Redo", crate::composer_input::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", crate::composer_input::Cut, OsAction::Cut),
            MenuItem::os_action("Copy", crate::composer_input::Copy, OsAction::Copy),
            MenuItem::os_action("Paste", crate::composer_input::Paste, OsAction::Paste),
            MenuItem::separator(),
            MenuItem::os_action(
                "Select All",
                crate::composer_input::SelectAll,
                OsAction::SelectAll,
            ),
        ]),
    ];
    if cfg!(target_os = "macos") {
        menus.push(Menu::new("Window").items([
            MenuItem::action("Minimize", Minimize),
            MenuItem::action("Zoom", Zoom),
            MenuItem::separator(),
            MenuItem::action("Close Window", CloseWindow),
        ]));
    }
    menus
}

#[cfg(test)]
mod tests {
    use gpui::Action as _;

    use super::*;

    #[test]
    fn edit_menu_routes_native_clipboard_actions_to_the_composer() {
        let menus = app_menus();
        let edit = menus
            .iter()
            .find(|menu| menu.name.as_ref() == "Edit")
            .expect("Edit menu present");
        let expected = [
            (crate::composer_input::Cut.name(), OsAction::Cut),
            (crate::composer_input::Copy.name(), OsAction::Copy),
            (crate::composer_input::Paste.name(), OsAction::Paste),
            (crate::composer_input::SelectAll.name(), OsAction::SelectAll),
        ];
        let actual: Vec<(&str, OsAction)> = edit
            .items
            .iter()
            .filter_map(|item| match item {
                MenuItem::Action {
                    action,
                    os_action: Some(os_action),
                    ..
                } => Some((action.name(), *os_action)),
                _ => None,
            })
            .collect();
        assert_eq!(actual.len(), expected.len());
        for ((actual_name, actual_os), (expected_name, expected_os)) in
            actual.iter().zip(expected.iter())
        {
            assert_eq!(actual_name, expected_name);
            assert!(actual_os == expected_os, "OS action mismatch");
        }
    }
}
