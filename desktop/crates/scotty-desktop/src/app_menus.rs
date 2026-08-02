//! Native application and window menus, adapted from Comet's GPUI shell.

use gpui::{App, KeyBinding, Menu, MenuItem, SystemMenuType, Window, actions};

actions!(
    scotty,
    [
        About,
        Quit,
        Hide,
        HideOthers,
        ShowAll,
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
    if cfg!(target_os = "macos") {
        cx.bind_keys([
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("cmd-h", Hide, None),
            KeyBinding::new("alt-cmd-h", HideOthers, None),
            KeyBinding::new("cmd-m", Minimize, None),
            KeyBinding::new("cmd-w", CloseWindow, None),
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

    let mut menus = vec![Menu::new("Scotty").items(app_items)];
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
