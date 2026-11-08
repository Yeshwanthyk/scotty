//! The window's frame: the sessions in a sidebar on the left (`ui/src/components/Sidebar.tsx`),
//! the open ones as tabs along the top, the page under them. Every session is in the sidebar; only
//! the ones the user opens get a tab, and closing a tab leaves the session where it was.

use rune::{Cx, El, LoopSpec, ScrollSpec, TextStyle, Tx, col, el, icon, row, text};
use rune_kit::Kit;
use rune_kit::shell::{TabItem, TabItemStatus, TabOrientation, TabReorder, TabStrip};

use crate::api::{Session, Status};
use crate::live::Link;
use crate::theme::{BAR, META, Palette, RADIUS, SIDEBAR_WIDTH, SMALL, TITLE, icons};
use crate::{Filter, State, time};

/// The traffic lights' room when the sidebar is hidden and the tabs start at the window's edge.
const LIGHTS: f32 = 78.0;

/// The sessions the sidebar lists under the chips: the filter, then the repository ⌘K picked.
pub fn listed(s: &State) -> Vec<&Session> {
    let mut out: Vec<&Session> = s.sessions.iter().filter(|x| s.filter.matches(x) && s.repo_filter.as_ref().is_none_or(|r| x.display.repository == *r)).collect();
    out.sort_by(|a, b| b.display.active_at.cmp(&a.display.active_at));
    out
}

/// The sidebar's own type: a row title, and its group labels, a step quieter than the page's.
const ROW_TITLE: TextStyle = TextStyle::new(13.0, 400.0).lh(17.0);
const ROW_TITLE_STRONG: TextStyle = TextStyle::new(13.0, 500.0).lh(17.0);
const LABEL: TextStyle = TextStyle::new(11.0, 500.0).lh(14.0);
/// Every control in the sidebar is this tall and this round, as in the web's sidebar.
const CONTROL: f32 = 30.0;
const CONTROL_RADIUS: f32 = 8.0;
/// Where the search row sits: under the title bar and the brand row.
const TOOLS_TOP: f32 = BAR + 34.0;

pub fn sidebar(s: &State, cx: &Cx<State>, k: &Kit, p: &Palette, layer: &mut Vec<El>) -> El {
    let now = s.now();
    let head = row()
        .key("sidebar-head")
        .w_full()
        .h(BAR)
        .pl(cx.titlebar_inset().max(LIGHTS))
        .pr(8.0)
        .center_y()
        .window_drag()
        .child(el().grow(1.0))
        .child(icon_button("hide-sidebar", &icons::SIDEBAR, "Hide sidebar (⌘\\)", p).on_press(|s: &mut State| s.sidebar = false));

    let brand = row()
        .key("brand")
        .w_full()
        .h(34.0)
        .pl(6.0)
        .gap(8.0)
        .center_y()
        .child(icon(&icons::MARK, 20.0))
        .child(text("Scotty").font(TITLE).color(p.ink));

    // Search and its filter share one field; New session stands apart as the main action.
    let filtered = s.filter != Filter::All || s.repo_filter.is_some();
    let search = row()
        .key("sidebar-search")
        .role("button")
        .label("Search sessions, repos and actions")
        .help("Search (⌘K)")
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .h_full()
        .pl(8.0)
        .pr(6.0)
        .gap(6.0)
        .center_y()
        .radius(CONTROL_RADIUS)
        .hover(p.hover)
        .child(icon(&icons::SEARCH, 14.0).color(p.quiet))
        .child(text("Search").font(ROW_TITLE).color(p.quiet).grow(1.0))
        .child(crate::palette::keycap("⌘K", p))
        .on_press(|s: &mut State| s.open_palette());
    let filter = el()
        .key("sidebar-filter")
        .role("button")
        .label("Filter sessions")
        .help("Filter sessions")
        .w(CONTROL)
        .h_full()
        .center()
        .radius(CONTROL_RADIUS)
        .hover(p.hover)
        .child(icon(&icons::FILTER, 14.0).color(if filtered { p.accent } else { p.quiet }))
        .on_press(|s: &mut State| s.filter_menu = !s.filter_menu);
    let field = row()
        .key("sidebar-field")
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .h(CONTROL)
        .radius(CONTROL_RADIUS)
        .fill(p.hover)
        .center_y()
        .child(search)
        .child(el().w(1.0).h(14.0).fill(p.line_strong))
        .child(filter);
    let new = el()
        .key("new-session")
        .role("button")
        .label("New session")
        .help("New session (⌘N)")
        .size(CONTROL, CONTROL)
        .radius(CONTROL_RADIUS)
        .center()
        .fill(p.selected)
        .border(1.0, p.line_strong)
        .child(icon(&icons::PLUS, 15.0).color(p.ink))
        .on_press(|s: &mut State| s.start_new());
    let tools = row().key("sidebar-tools").w_full().gap(6.0).center_y().child(field).child(new);

    // A filter in force shows as a chip that clears it; with none, the row is not there.
    let mut chips = row().key("chips").w_full().gap(4.0).pt(6.0).flex_wrap();
    let chip = |key: String, label: String, clear: &'static str| {
        row()
            .key(&key)
            .role("button")
            .label(format!("Clear the {label} filter"))
            .help(clear)
            .h(22.0)
            .pl(7.0)
            .pr(4.0)
            .gap(3.0)
            .radius(CONTROL_RADIUS)
            .center_y()
            .fill(p.hover)
            .child(text(label).font(SMALL).color(p.muted).max_lines(1).shrink().min_w(0.0))
            .child(icon(&icons::X, 10.0).color(p.quiet))
    };
    if let Some((_, label)) = Filter::ALL.iter().find(|(f, _)| *f == s.filter && *f != Filter::All) {
        chips = chips.child(chip(format!("chip:{label}"), label.to_string(), "Clear session filter").on_press(|s: &mut State| s.filter = Filter::All));
    }
    if let Some(repo) = &s.repo_filter {
        chips = chips.child(chip("chip:repo".to_string(), repo.clone(), "Clear repository").on_press(|s: &mut State| s.repo_filter = None));
    }
    if s.filter_menu {
        filter_menu(s, p, layer);
    }

    let shown = listed(s);
    let (stopped, live): (Vec<&Session>, Vec<&Session>) = shown.iter().partition(|x| x.dormant());
    let mut list = col().key("session-list").w_full().gap(1.0);
    let quiet_line = |words: &str| text(words.to_string()).font(META).color(p.quiet).wrap().px(10.0).py(8.0);
    if s.list_error.is_some() && s.sessions.is_empty() {
        list = list.child(quiet_line("Can't reach Scotty. Retrying…"));
    } else if s.listed && s.sessions.is_empty() {
        list = list.child(quiet_line("No sessions yet. Start one and it shows up here."));
    } else if s.listed && shown.is_empty() {
        list = list.child(quiet_line("Nothing matches."));
    }
    let mut group = usize::MAX;
    for x in &live {
        let g = time::group_of(&x.display.active_at, now);
        if g != group {
            let label = time::GROUPS[g];
            list = list.child(text(label).key(format!("group:{label}")).font(LABEL).color(p.quiet).px(8.0).pt(12.0).pb(4.0));
            group = g;
        }
        list = list.child(session_row(s, x, k, p, now));
    }
    if !stopped.is_empty() {
        let open = s.show_stopped.unwrap_or(live.is_empty());
        list = list.child(
            row()
                .key("stopped-toggle")
                .role("button")
                .label(if open { "Hide stopped sessions" } else { "Show stopped sessions" })
                .w_full()
                .h(28.0)
                .mt(8.0)
                .px(8.0)
                .gap(4.0)
                .center_y()
                .radius(CONTROL_RADIUS)
                .hover(p.hover)
                .child(text("Stopped").font(LABEL).color(p.quiet))
                .child(icon(if open { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 12.0).color(p.quiet))
                .child(el().grow(1.0))
                .child(text(stopped.len().to_string()).font(SMALL).color(p.quiet))
                .on_press(move |s: &mut State| s.show_stopped = Some(!open)),
        );
        if open {
            for x in &stopped {
                list = list.child(session_row(s, x, k, p, now));
            }
        }
    }
    let scroll = col().key("sidebar-scroll").w_full().grow(1.0).shrink().min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).scroll_edge_fade(16.0).child(list);

    let host = s.server.as_ref();
    let (dot, why) = match &s.list_link {
        Link::Open => (p.done, "Connected".to_string()),
        Link::Connecting => (p.quiet, "Connecting…".to_string()),
        Link::Retrying(why) => (p.danger, format!("Offline · {why}")),
        Link::Closed => (p.danger, "Offline".to_string()),
        Link::SignIn => (p.quiet, "Signed out".to_string()),
    };
    let foot = row()
        .key("sidebar-foot")
        .w_full()
        .h(38.0)
        .gap(4.0)
        .center_y()
        .child(
            row()
                .key("host")
                .role("button")
                .label("Switch Scotty")
                .help(host.map_or(String::new(), |h| format!("{} · {why} · switch Scotty", h.url)))
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .h(CONTROL)
                .px(8.0)
                .gap(8.0)
                .center_y()
                .radius(CONTROL_RADIUS)
                .hover(p.hover)
                .child(el().size(7.0, 7.0).radius(3.5).fill(dot))
                .child(text(host.map_or("Scotty", |h| h.name.as_str()).to_string()).font(META).color(p.muted).max_lines(1).shrink().min_w(0.0))
                .on_press(|s: &mut State| s.switch()),
        )
        .child(icon_button("open-settings", &icons::SETTINGS, "Settings (⌘,)", p).on_press(|s: &mut State| s.open_settings(None)));

    col()
        .key("sidebar")
        .w(SIDEBAR_WIDTH)
        .h_full()
        .fill(p.sidebar)
        .border_sides([0.0, 1.0, 0.0, 0.0], p.line)
        .child(head)
        .child(col().w_full().grow(1.0).shrink().min_h(0.0).px(8.0).child(brand).child(tools).child(chips).child(scroll))
        .child(col().w_full().px(8.0).pb(4.0).child(el().w_full().h(1.0).mb(2.0).fill(p.line)).child(foot))
}

/// One session: a mark for news on the left (a spinner while it works, a dot for a failure or an
/// unseen reply), then its title on one line and its status or repository and age under it.
fn session_row(s: &State, x: &Session, k: &Kit, p: &Palette, now: f64) -> El {
    let id = x.id().to_string();
    let selected = s.current() == Some(x.id());
    let tabbed = s.tabs.iter().any(|t| t == x.id());
    let status = s.status_of(x);
    let repo = match x.display.repository.rsplit('/').next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => "No repository".to_string(),
    };
    let mut line = row().gap(4.0).center_y().min_w(0.0);
    if x.claude() {
        line = line.child(text("Claude ·").font(SMALL).color(p.accent));
    }
    if status.loud() {
        let color = match status {
            Status::Failed => p.danger,
            Status::Unseen => p.attention,
            _ => p.working,
        };
        line = line.child(text(status.label().to_string()).font(SMALL).color(color)).child(text(format!("· {repo}")).font(SMALL).color(p.quiet).max_lines(1).shrink().min_w(0.0));
    } else {
        line = line.child(text(format!("{repo} · {}", time::ago(&x.display.active_at, now))).font(SMALL).color(p.quiet).max_lines(1).shrink().min_w(0.0));
    }
    let mark = match status {
        Status::Working | Status::Starting => spinner(12.0, p.working, k),
        Status::Failed => el().size(6.0, 6.0).radius(3.0).fill(p.danger),
        Status::Unseen => el().size(6.0, 6.0).radius(3.0).fill(p.attention),
        _ if tabbed && !selected => el().size(4.0, 4.0).radius(2.0).fill(p.quiet).help("Open in a tab"),
        _ => el(),
    };
    let title_color = if selected || matches!(status, Status::Unseen | Status::Working | Status::Starting) { p.ink } else if x.dormant() { p.quiet } else { p.muted };
    let mut item = row()
        .key(format!("row:{id}"))
        .role("button")
        .label(format!("Open {}", x.display.title))
        .help(&x.display.title)
        .w_full()
        .py(5.0)
        .px(8.0)
        .gap(8.0)
        .center_y()
        .radius(CONTROL_RADIUS)
        .hover(p.hover)
        .child(el().size(14.0, 14.0).center().child(mark))
        .child(
            col()
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .gap(1.0)
                .child(text(x.display.title.clone()).font(if selected { ROW_TITLE_STRONG } else { ROW_TITLE }).color(title_color).max_lines(1))
                .child(line),
        )
        .on_press(move |s: &mut State| s.open_session(&id));
    if selected {
        item = item.fill(p.selected);
    }
    item
}

/// The filter menu under the search field: one choice at a time, the current one checked.
fn filter_menu(s: &State, p: &Palette, layer: &mut Vec<El>) {
    let mut menu = col().key("filter-menu").role("menu").label("Filter sessions").w(180.0).padding(5.0).radius(RADIUS).fill(p.surface).border(1.0, p.line_strong).shadow(8.0, 24.0, p.shadow);
    for (filter, label) in Filter::ALL {
        let on = s.filter == filter;
        menu = menu.child(
            row()
                .key(format!("filter:{label}"))
                .role("menuitem")
                .label(label)
                .w_full()
                .h(28.0)
                .px(8.0)
                .gap(8.0)
                .radius(6.0)
                .center_y()
                .hover(p.hover)
                .child(text(label).font(META).color(p.ink).grow(1.0))
                .child(if on { icon(&icons::CHECK, 14.0).color(p.ink) } else { el().size(14.0, 14.0) })
                .on_press(move |s: &mut State| {
                    s.filter = filter;
                    s.filter_menu = false;
                }),
        );
    }
    let menu = menu.modal(true, |s: &mut State| s.filter_menu = false);
    layer.push(col().key("filter-menu-layer").absolute(0.0, 0.0).w_full().h_full().pt(TOOLS_TOP + CONTROL + 6.0).pl(8.0).child(menu));
}

/// The tab strip across the top, the window's drag band. Each tab is a session the user opened.
pub fn tab_bar(s: &State, cx: &Cx<State>, k: &Kit, p: &Palette, layer: &mut Vec<El>) -> El {
    let items: Vec<TabItem<'_, State>> = s
        .tabs
        .iter()
        .map(|id| {
            let conn = s.conns.iter().find(|c| c.id == *id);
            let status = s.session(id).map(|x| s.status_of(x));
            let tab = match status {
                Some(Status::Working | Status::Starting) => Some(TabItemStatus::Busy),
                Some(Status::Failed) => Some(TabItemStatus::Failed),
                _ if conn.is_some_and(|c| c.missing) => Some(TabItemStatus::Failed),
                _ => None,
            };
            TabItem::new(id.clone(), s.title_of(id)).icon(&icons::REPO).status(tab)
        })
        .collect();
    let plus = icon_button("new-tab", &icons::PLUS, "New session (⌘N)", p).on_press(|s: &mut State| s.start_new());
    let strip = TabStrip::new("tabs", TabOrientation::Horizontal)
        .tabs(items)
        .active(s.current())
        .viewport_width(cx.layout_size("tabs").map(|z| z[0]))
        .drag_state(&s.drag, |s: &mut State| &mut s.drag)
        .fill(p.bg)
        .close_icon(&icons::X)
        .trailing_action(plus)
        .label("Open sessions")
        .on_select(|s: &mut State, id: &str, _: &mut Tx| {
            if let Some(i) = s.tabs.iter().position(|t| t == id) {
                s.select(i);
            }
        })
        .on_close(|s: &mut State, id: &str, _: &mut Tx| {
            if let Some(i) = s.tabs.iter().position(|t| t == id) {
                s.close_tab(i);
            }
        })
        .on_reorder(|s: &mut State, r: TabReorder, _: &mut Tx| s.move_tab(r.from, r.to))
        .build_layered(k, layer);
    let mut bar = row().key("tab-bar").w_full().h(BAR).pr(12.0).gap(6.0).center_y().fill(p.bg).border_sides([0.0, 0.0, 1.0, 0.0], p.line).window_drag();
    bar = if s.sidebar {
        bar.pl(8.0)
    } else {
        bar.pl(cx.titlebar_inset().max(LIGHTS)).child(icon_button("show-sidebar", &icons::SIDEBAR, "Show sidebar (⌘\\)", p).on_press(|s: &mut State| s.sidebar = true))
    };
    bar.child(strip)
}

pub fn icon_button(key: &str, glyph: &'static rune::Icon, label: &str, p: &Palette) -> El {
    el().key(key)
        .role("button")
        .label(label)
        .help(label)
        .size(30.0, 30.0)
        .radius(8.0)
        .center()
        .hover(p.hover)
        .child(icon(glyph, 16.0).color(p.quiet))
}

/// The web's spinner: a faint ring and an arc turning once every 900 ms (rune-kit's loader).
pub fn spinner(size: f32, color: rune::Color, k: &Kit) -> El {
    rune_kit::Loader::new().size(size).color(color).build(k)
}

/// "Working": the label breathing while the agent works.
pub fn breathing(t: El) -> El {
    t.looping(LoopSpec::opacity(1.6, 0.0, 0.45, 1.0))
}
