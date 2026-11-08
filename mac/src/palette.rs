//! ⌘K, as the web's `CommandMenu.tsx` fills it: running sessions first, then the actions, then
//! the repositories matching what's typed (which set the sidebar's repository filter), then every
//! other session. A session matches on its title, repository, branch, first prompt and origin; an
//! action on its label and detail. One desktop action joins the web's:
//! Changes. The appearance follows macOS.

use rune::{
    El, Key, KeyEvent, LoopSpec, ScrollSpec, TextEdit, Tx, col, el, icon, row, text, text_input,
};

use crate::api::{Origin, Session, Status};
use crate::settings::{PAGES, Section};
use crate::theme::{BODY, HEAD, META, Palette, ROW, SMALL, icons};
use crate::{State, time};

/// The palette while it's open: what's typed and which result is picked.
pub struct Finder {
    pub query: TextEdit,
    pub index: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    New,
    Open(String),
    Repo(String),
    Sidebar,
    Changes,
    Stats,
    Settings(Section),
}

#[derive(Clone, Debug)]
pub struct Command {
    pub id: String,
    pub section: &'static str,
    pub label: String,
    pub detail: String,
    /// Sessions carry their status mark.
    pub status: Option<Status>,
    pub act: Act,
}

/// The web's `matchesText`.
pub fn matches_text(s: &Session, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    let d = &s.display;
    let origin = match &d.origin {
        Some(Origin::Api { key }) => key.as_str(),
        Some(Origin::Hook { connection, .. }) => connection.as_str(),
        Some(Origin::Automation { automation, .. }) => automation.as_str(),
        None => "",
    };
    [
        d.title.as_str(),
        &d.repository,
        &d.branch,
        &d.prompt,
        origin,
    ]
    .iter()
    .any(|f| f.to_lowercase().contains(needle))
}

pub fn commands(s: &State) -> Vec<Command> {
    let query = s
        .finder
        .as_ref()
        .map(|f| f.query.text.clone())
        .unwrap_or_default();
    let needle = query.trim().to_lowercase();
    let now = s.now();
    let action = |id: &str, label: &str, detail: &str, act: Act| Command {
        id: id.into(),
        section: "Actions",
        label: label.into(),
        detail: detail.into(),
        status: None,
        act,
    };
    let mut actions = vec![
        action("new", "New session", "⌘N", Act::New),
        action(
            "sidebar",
            if s.sidebar {
                "Hide sidebar"
            } else {
                "Show sidebar"
            },
            "⌃⌘S",
            Act::Sidebar,
        ),
    ];
    if s.conn().is_some() {
        actions.push(action(
            "changes",
            if s.panel {
                "Hide changes"
            } else {
                "Show changes"
            },
            "⌥⌘D",
            Act::Changes,
        ));
    }
    actions.push(action(
        "stats",
        "Stats",
        "Hours, turns and failures per repository",
        Act::Stats,
    ));
    for page in PAGES {
        actions.push(action(
            &format!("settings-{}", page.id),
            &format!("Settings: {}", page.label),
            page.detail,
            Act::Settings(page.section),
        ));
    }
    actions.retain(|c| {
        needle.is_empty()
            || format!("{} {}", c.label, c.detail)
                .to_lowercase()
                .contains(&needle)
    });

    let mut matching: Vec<&Session> = s
        .sessions
        .iter()
        .filter(|x| matches_text(x, &needle))
        .collect();
    matching.sort_by(|a, b| b.display.active_at.cmp(&a.display.active_at));
    let session = |x: &Session| Command {
        id: x.id().to_string(),
        section: if x.running() { "Running" } else { "Sessions" },
        label: x.display.title.clone(),
        detail: format!(
            "{} · {}",
            x.display.repository,
            time::ago(&x.display.active_at, now)
        ),
        status: Some(s.status_of(x)),
        act: Act::Open(x.id().to_string()),
    };
    let running: Vec<Command> = matching
        .iter()
        .filter(|x| x.running())
        .map(|x| session(x))
        .collect();
    let rest: Vec<Command> = matching
        .iter()
        .filter(|x| !x.running())
        .map(|x| session(x))
        .collect();
    let mut repos: Vec<String> = Vec::new();
    for x in &s.sessions {
        let r = &x.display.repository;
        if !r.is_empty()
            && !needle.is_empty()
            && r.to_lowercase().contains(&needle)
            && !repos.contains(r)
        {
            repos.push(r.clone());
        }
    }
    let repos = repos.into_iter().map(|r| Command {
        id: format!("repo-{r}"),
        section: "Repositories",
        label: r.clone(),
        detail: "Show its sessions".into(),
        status: None,
        act: Act::Repo(r),
    });
    running
        .into_iter()
        .chain(actions)
        .chain(repos)
        .chain(rest)
        .collect()
}

impl State {
    pub fn open_palette(&mut self) {
        self.finder = match self.finder {
            Some(_) => None,
            None => Some(Finder {
                query: TextEdit::new(""),
                index: 0,
            }),
        };
    }

    pub fn run(&mut self, act: Act) {
        self.finder = None;
        match act {
            Act::New => self.start_new(),
            Act::Open(id) => self.open_session(&id),
            Act::Repo(repo) => {
                self.sidebar = true;
                self.repo_filter = Some(repo);
            }
            Act::Sidebar => self.sidebar = !self.sidebar,
            Act::Changes => self.panel = !self.panel,
            Act::Stats => {
                if let Some(server) = &self.server {
                    open_url(&format!("{}/stats", server.url));
                }
            }
            Act::Settings(section) => self.open_settings(Some(section)),
        }
    }

    /// Arrows move the pick, Return runs it; Escape is the modal's.
    fn palette_key(&mut self, ev: &KeyEvent, tx: &mut Tx) -> bool {
        let shown = commands(self);
        let n = shown.len().max(1);
        let Some(f) = self.finder.as_mut() else {
            return false;
        };
        let at = f.index.min(n - 1);
        match ev.key {
            Key::Down => f.index = (at + 1) % n,
            Key::Up => f.index = (at + n - 1) % n,
            Key::Enter => {
                if let Some(c) = shown.into_iter().nth(at) {
                    self.run(c.act);
                }
                return true;
            }
            _ => return false,
        }
        if let Some(c) = shown.get(f.index) {
            tx.scroll_into_view(format!("palette-item:{}", c.id));
        }
        true
    }
}

/// Open a page in the browser.
pub fn open_url(url: &str) {
    let _ = std::process::Command::new("open").arg(url).spawn();
}

/// The palette over the window, as the web's: a scrim, the panel high on the page.
pub fn view(s: &State, k: &rune_kit::Kit, p: &Palette, layer: &mut Vec<El>) {
    let Some(f) = &s.finder else { return };
    let results = commands(s);
    let active = f.index.min(results.len().saturating_sub(1));
    let input = text_input(&f.query, BODY.lh(22.0))
        .key("palette-input")
        .label("Search sessions, repos and actions")
        .placeholder("Search sessions, repos and actions", p.quiet)
        .color(p.ink)
        .grow(1.0)
        .shrink()
        .on_edit(|s: &mut State| {
            let f = s.finder.get_or_insert_with(|| Finder {
                query: TextEdit::new(""),
                index: 0,
            });
            f.index = 0;
            &mut f.query
        })
        .on_input_key(|s: &mut State, ev, tx| s.palette_key(ev, tx));
    let search = row()
        .key("palette-search")
        .w_full()
        .h(56.0)
        .pl(18.0)
        .pr(14.0)
        .gap(12.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
        .child(icon(&icons::SEARCH, 17.0).color(p.quiet))
        .child(input)
        .child(keycap("esc", p));
    let mut list = col().key("palette-list").w_full().padding(6.0);
    if results.is_empty() {
        let words = if f.query.text.trim().is_empty() {
            "No sessions here".to_string()
        } else {
            format!("Nothing matches “{}”", f.query.text.trim())
        };
        list = list.child(
            row()
                .w_full()
                .py(18.0)
                .center()
                .child(text(words).font(META).color(p.quiet)),
        );
    }
    for (at, c) in results.iter().enumerate() {
        if at == 0 || results[at - 1].section != c.section {
            list = list.child(
                text(c.section)
                    .font(HEAD)
                    .color(p.quiet)
                    .px(10.0)
                    .pt(if at == 0 { 4.0 } else { 10.0 })
                    .pb(4.0),
            );
        }
        let act = c.act.clone();
        let mut item = row()
            .key(&format!("palette-item:{}", c.id))
            .role("option")
            .label(&c.label)
            .w_full()
            .h(34.0)
            .px(10.0)
            .gap(10.0)
            .center_y()
            .radius(8.0)
            .hover(p.hover)
            .on_press(move |s: &mut State| s.run(act.clone()));
        if let Some(status) = c.status {
            item = item.child(
                row()
                    .size(14.0, 14.0)
                    .center()
                    .child(status_mark(status, k, p)),
            );
        }
        item = item
            .child(
                text(c.label.clone())
                    .font(ROW)
                    .color(p.ink)
                    .max_lines(1)
                    .shrink()
                    .min_w(0.0),
            )
            .child(
                text(c.detail.clone())
                    .font(SMALL)
                    .color(p.quiet)
                    .max_lines(1)
                    .grow(1.0)
                    .shrink()
                    .min_w(0.0),
            );
        if at == active {
            item = item.fill(p.selected);
        }
        list = list.child(item);
    }
    let panel = col()
        .key("palette")
        .role("dialog")
        .label("Command menu")
        .w_full()
        .max_w(620.0)
        .max_h(460.0)
        .radius(14.0)
        .clip_rounded(14.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .shadow(12.0, 32.0, p.shadow)
        .child(search)
        .child(
            col()
                .key("palette-scroll")
                .w_full()
                .shrink()
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(list),
        )
        .modal(true, |s: &mut State| s.finder = None);
    layer.push(
        el().key("palette-scrim")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .fill(p.scrim)
            .a11y_hidden(),
    );
    layer.push(
        col()
            .key("palette-layer")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .px(16.0)
            .pt(96.0)
            .items_center()
            .child(panel),
    );
}

/// The web's `StatusMark`: a spinner while it works, a dot for a failure or an unseen reply, and
/// nothing for a quiet session.
pub fn status_mark(status: Status, k: &rune_kit::Kit, p: &Palette) -> El {
    let color = match status {
        Status::Working | Status::Starting => return crate::shell::spinner(12.0, p.working, k),
        Status::Unseen => p.attention,
        Status::Failed => p.danger,
        Status::Idle | Status::Asleep | Status::Stopped => return el(),
    };
    let dot = el().size(7.0, 7.0).radius(3.5).fill(color);
    if status == Status::Unseen {
        dot.looping(LoopSpec::opacity(2.0, 0.0, 0.5, 1.0))
    } else {
        dot
    }
}

pub fn keycap(label: &str, p: &Palette) -> El {
    el().px(6.0)
        .h(18.0)
        .radius(5.0)
        .fill(p.raised)
        .center()
        .child(text(label.to_string()).font(SMALL).color(p.quiet))
}
