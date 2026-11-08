//! The menu bar: every window command a Mac user looks for there, with its shortcut. Rune adds
//! the standard Edit and Window items; these join them. Each item lets the window's key handler
//! (`keys` in main.rs) see its shortcut first, so a press does one thing whichever way it comes.
//! A session's own actions open as a native pop-up menu, from its ⋯ button, its sidebar row or
//! its tab.
use rune::{AppHandle, MenuItem, PopupAnchor, PopupItem, PopupMenu, Shortcut, Tx};

use crate::State;
use crate::api::Status;

/// What the items' titles and enabled states depend on; the menu is rebuilt when it changes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Shown {
    open: bool,
    sidebar: bool,
    panel: bool,
    tabs: usize,
}

pub fn shown(s: &State) -> Shown {
    Shown {
        open: s.server.is_some(),
        sidebar: s.sidebar,
        panel: s.panel,
        tabs: s.tabs.len(),
    }
}

/// Puts the menu for `now` in place unless it is already there.
pub fn sync(handle: &AppHandle<State>, last: &std::cell::Cell<Option<Shown>>, now: Shown) {
    if last.get() == Some(now) {
        return;
    }
    if handle.set_menu(items(now)).is_ok() {
        last.set(Some(now));
    }
}

fn keys(item: MenuItem<State>, shortcut: &str) -> MenuItem<State> {
    match shortcut.parse::<Shortcut>() {
        Ok(k) => item.key_equivalent(k).keys_first(),
        Err(_) => item,
    }
}

fn items(m: Shown) -> Vec<MenuItem<State>> {
    vec![
        keys(
            MenuItem::new("Settings…", |s: &mut State, _: &mut Tx| {
                s.open_settings(None)
            })
            .id("settings"),
            "cmd+,",
        )
        .enabled(m.open),
        keys(
            MenuItem::new("New Session", |s: &mut State, _: &mut Tx| s.start_new())
                .id("new-session")
                .menu("File"),
            "cmd+n",
        )
        .enabled(m.open),
        keys(
            MenuItem::new("Command Menu…", |s: &mut State, _: &mut Tx| {
                s.open_palette()
            })
            .id("command-menu")
            .menu("File"),
            "cmd+k",
        )
        .enabled(m.open),
        keys(
            MenuItem::new(
                if m.sidebar {
                    "Hide Sidebar"
                } else {
                    "Show Sidebar"
                },
                |s: &mut State, _: &mut Tx| s.sidebar = !s.sidebar,
            )
            .id("sidebar")
            .menu("View"),
            "ctrl+cmd+s",
        )
        .enabled(m.open),
        keys(
            MenuItem::new(
                if m.panel {
                    "Hide Changes"
                } else {
                    "Show Changes"
                },
                |s: &mut State, _: &mut Tx| s.panel = !s.panel,
            )
            .id("changes")
            .menu("View"),
            "alt+cmd+d",
        )
        .enabled(m.open && m.tabs > 0),
        MenuItem::separator().menu("Window"),
        keys(
            MenuItem::new("Show Previous Tab", |s: &mut State, _: &mut Tx| step(s, -1))
                .id("previous-tab")
                .menu("Window"),
            "shift+cmd+[",
        )
        .enabled(m.tabs > 1),
        keys(
            MenuItem::new("Show Next Tab", |s: &mut State, _: &mut Tx| step(s, 1))
                .id("next-tab")
                .menu("Window"),
            "shift+cmd+]",
        )
        .enabled(m.tabs > 1),
    ]
}

fn step(s: &mut State, by: isize) {
    let n = s.tabs.len().max(1) as isize;
    s.select((s.active as isize + by).rem_euclid(n) as usize);
}

/// Opens the actions for session `id` at `at`: copy its ID, and resume, stop or delete it as its
/// state allows. Stop and Delete act on the session in its tab, where they ask first.
pub fn session_actions(s: &State, id: &str, at: impl Into<PopupAnchor>, tx: &mut Tx) {
    let x = s
        .conns
        .iter()
        .find(|c| c.id == id)
        .and_then(|c| c.session.as_ref())
        .or_else(|| s.session(id));
    let status = x.map(|x| s.status_of(x));
    let stopped = matches!(status, Some(Status::Stopped | Status::Asleep));
    let failed = status == Some(Status::Failed);
    let resumable = stopped
        || (failed
            && x.and_then(|x| x.failure())
                .is_some_and(|f| f.recovery == "resume"));
    let running = x.is_some_and(|x| x.lifecycle() == Some("running"));
    let mut menu = PopupMenu::new().item(PopupItem::new("copy", "Copy Session ID"));
    if resumable {
        menu = menu.item(PopupItem::new("resume", "Resume Session"));
    }
    if running {
        menu = menu.item(PopupItem::new("stop", "Stop Session"));
    }
    if stopped || failed {
        menu = menu
            .separator()
            .item(PopupItem::new("delete", "Delete Session…"));
    }
    let id = id.to_string();
    tx.popup_menu(menu, at, move |s: &mut State, picked, _| {
        let action = match picked {
            Some("copy") => return crate::copy(&id),
            Some("resume") => "resume",
            Some("stop") => "stop",
            Some("delete") => "delete",
            _ => return,
        };
        s.open_session(&id);
        s.act(action);
    });
}
