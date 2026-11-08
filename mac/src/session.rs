//! One session, as `ui/src/routes/s.$sessionId.tsx` draws it: the header, the thread at the web's
//! width (`Thread.tsx`, `ToolRow.tsx`, `Lifecycle.tsx`), the floating composer, and the Changes
//! panel on the right (`Changes.tsx`, `DiffLines.tsx`). Every word is the web's.

use rune::{El, ScrollSpec, col, el, icon, row, text, text_input};
use rune_kit::{Kit, Markdown, MarkdownStyle};

use crate::api::{self, Authority, Item, Session, Status, Tool, Turn, TurnState};
use crate::diff::{self, FileDiff, LineKind, Shown};
use crate::live::Link;
use crate::shell::{breathing, icon_button, spinner};
use crate::theme::{
    BODY, CODE, COMPOSER, HEADER, LOG, LOG_MONO, META, META_STRONG, PILL, Palette, RADIUS, RADIUS_MD, SMALL, THREAD_WIDTH, TITLE, icons,
};
use crate::{Conn, State, time};

/// The thread's side gutter.
const GUTTER: f32 = 24.0;
/// Turns shown before "N earlier turns".
const OPEN_TURNS: usize = 3;
/// Output lines shown before "Show N more lines".
const SHOWN_LINES: usize = 40;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Live,
    Booting,
    Dormant,
}

/// What every part of the page reads.
struct Page<'a> {
    s: &'a State,
    conn: &'a Conn,
    k: &'a Kit,
    md: &'a MarkdownStyle,
    p: &'a Palette,
    now: f64,
}

impl Page<'_> {
    /// A key for something the user opens, unique to this session.
    fn key(&self, what: &str, id: &str) -> String {
        format!("{}:{what}:{id}", self.conn.id)
    }
    fn opened(&self, what: &str, id: &str) -> bool {
        self.s.open.contains(&self.key(what, id))
    }
}

/// The page under the tab bar.
pub fn page(s: &State, conn: &Conn, k: &Kit, md: &MarkdownStyle, p: &Palette, layer: &mut Vec<El>) -> El {
    let pg = Page { s, conn, k, md, p, now: s.now() };
    let session = conn.session.as_ref();
    let status = session.map(|x| Status::of(x, None, true));
    let turns = conn.turns();
    let changes = diff::session_changes(turns);
    let working = status == Some(Status::Working);
    let last = turns.last();
    let waiting = working && last.is_some_and(|t| t.state == TurnState::Streaming && t.items.is_empty() && t.assistant.is_empty());
    let boot_step = match session.map(|x| &x.authority) {
        Some(Authority::Transitioning { phase }) => Some(if phase == "workspace" { 1 } else { 0 }),
        _ if waiting && (conn.booted || turns.len() == 1) => Some(2),
        _ => None,
    };
    let mode = if boot_step.is_some() {
        Mode::Booting
    } else if working {
        Mode::Live
    } else {
        Mode::Dormant
    };

    let mut inner = col().key(&format!("thread-inner:{}", conn.id)).w_full().max_w(THREAD_WIDTH).pt(20.0).pb(28.0).gap(28.0);
    if conn.conversation.is_some() {
        inner = thread(&pg, inner, turns, mode);
    } else if !conn.missing {
        inner = inner.child(placeholder(p));
    }
    if let Some(step) = boot_step {
        inner = inner.child(boot_steps(step, &pg));
    }
    if let (Some(x), Some(status)) = (session, status) {
        if let Some(notice) = lifecycle(x, status, &pg) {
            inner = inner.child(notice);
        }
    }
    let thread = col()
        .key(&format!("thread:{}", conn.id))
        .role("log")
        .label("Conversation")
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .scroll(ScrollSpec { stick_bottom: true })
        .scroll_edge_fade(24.0)
        .child(row().w_full().justify_center().px(GUTTER).child(inner));
    let chat = col().key(&format!("chat:{}", conn.id)).grow(1.0).shrink().min_w(0.0).h_full().child(thread).child(composer(&pg, status));
    let mut workspace = row().key("workspace").w_full().grow(1.0).min_h(0.0).child(chat);
    if s.panel {
        workspace = workspace.child(changes_panel(&pg, &changes));
    }
    if conn.menu {
        actions_menu(&pg, status, layer);
    }
    if conn.confirm_delete {
        confirm_delete(p, layer);
    }
    col().key(&format!("session:{}", conn.id)).w_full().grow(1.0).min_h(0.0).child(header(&pg, status, &changes)).child(workspace)
}

// ── Header ─────────────────────────────────────────────────────────────────────────────────

fn header(pg: &Page, status: Option<Status>, changes: &[FileDiff]) -> El {
    let p = pg.p;
    let session = pg.conn.session.as_ref();
    let mut title = col().grow(1.0).shrink().min_w(0.0).gap(1.0).child(text(session.map_or(" ".to_string(), |x| x.display.title.clone())).font(TITLE).color(p.ink).max_lines(1));
    if let Some(x) = session {
        title = title.child(text(api::session_line(x).join(" · ")).font(SMALL).color(p.quiet).max_lines(1));
    }
    let mut actions = row().gap(6.0).center_y();
    let running = session.is_some_and(|x| x.lifecycle() == Some("running"));
    let sleeps = session.and_then(|x| x.progress.sleeps_at.as_ref()).filter(|_| running && status != Some(Status::Working));
    match (sleeps, status) {
        (Some(at), Some(Status::Idle | Status::Unseen)) => actions = actions.child(sleeps_in(at, pg.now, p)),
        (_, Some(status)) if !matches!(status, Status::Idle | Status::Unseen) => {
            if let Some(x) = session {
                actions = actions.child(status_pill(x, status, pg.k, p));
            }
        }
        _ => {}
    }
    let added: usize = changes.iter().map(|f| f.added).sum();
    let removed: usize = changes.iter().map(|f| f.removed).sum();
    let toggle = |s: &mut State| s.panel = !s.panel;
    if added > 0 || removed > 0 {
        let files = changes.len();
        actions = actions.child(
            row()
                .key("changes-button")
                .role("button")
                .label(&format!("Changes: {files} {}, {added} added, {removed} removed", if files == 1 { "file" } else { "files" }))
                .help("Changes (⌥⌘D)")
                .h(28.0)
                .px(10.0)
                .radius(RADIUS_MD)
                .center()
                .border(1.0, p.line)
                .fill(if pg.s.panel { p.selected } else { p.bg })
                .hover(p.hover)
                .child(diff_stat(added, removed, p))
                .on_press(toggle),
        );
    } else {
        let mut b = icon_button("changes-button", &icons::PANEL, "Changes, preview and files", p).on_press(toggle);
        if pg.s.panel {
            b = b.fill(p.selected);
        }
        actions = actions.child(b);
    }
    let mut more = icon_button("session-actions", &icons::MORE, "Session actions", p);
    if !pg.conn.busy {
        more = more.on_press(|s: &mut State| {
            if let Some(c) = s.conn_mut() {
                c.menu = !c.menu;
                c.copied = false;
            }
        });
    }
    actions = actions.child(more);
    row()
        .key("session-header")
        .w_full()
        .h(HEADER)
        .px(16.0)
        .gap(12.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
        .child(title)
        .child(actions)
}

fn sleeps_in(at: &str, now: f64, p: &Palette) -> El {
    let left = time::parse(at).map_or(0.0, |t| t - now);
    let words = if left < 60_000.0 { "Sleeps soon".to_string() } else { format!("Sleeps in {}m", (left / 60_000.0).round()) };
    row()
        .gap(5.0)
        .h(24.0)
        .px(8.0)
        .center_y()
        .help("An idle session sleeps to save cost; a message wakes it")
        .child(icon(&icons::MOON, 12.0).color(p.quiet))
        .child(text(words).font(PILL).color(p.muted))
}

fn status_pill(x: &Session, status: Status, k: &Kit, p: &Palette) -> El {
    let label = if status == Status::Stopped { api::stop_label(x.stop()) } else { status.label().to_string() };
    let color = match status {
        Status::Working | Status::Starting => p.working,
        Status::Failed => p.danger,
        _ => p.muted,
    };
    let mut pill = row().gap(5.0).h(24.0).px(9.0).radius(12.0).center_y().fill(p.raised);
    match status {
        Status::Working | Status::Starting => pill = pill.child(spinner(11.0, color, k)),
        Status::Asleep => pill = pill.child(icon(&icons::MOON, 11.0).color(color)),
        _ => {}
    }
    pill.child(text(label).font(PILL).color(color))
}

/// "Session actions": a small menu under its button.
fn actions_menu(pg: &Page, status: Option<Status>, layer: &mut Vec<El>) {
    let p = pg.p;
    let session = pg.conn.session.as_ref();
    let stopped = matches!(status, Some(Status::Stopped | Status::Asleep));
    let failed = status == Some(Status::Failed);
    let resumable = stopped || (failed && session.and_then(|x| x.failure()).is_some_and(|f| f.recovery == "resume"));
    let running = session.is_some_and(|x| x.lifecycle() == Some("running"));
    let item = |key: &str, label: &str, danger: bool| {
        row()
            .key(key)
            .role("menuitem")
            .label(label)
            .w_full()
            .h(30.0)
            .px(10.0)
            .radius(6.0)
            .center_y()
            .hover(p.hover)
            .child(text(label.to_string()).font(META).color(if danger { p.danger } else { p.ink }))
    };
    let mut menu = col()
        .key("session-menu")
        .role("menu")
        .label("Session actions")
        .w(196.0)
        .padding(5.0)
        .radius(RADIUS)
        .fill(p.surface)
        .border(1.0, p.line_strong)
        .shadow(8.0, 24.0, p.shadow)
        .child(item("menu-copy", if pg.conn.copied { "Copied" } else { "Copy session ID" }, false).on_press(|s: &mut State| s.copy_id()));
    if resumable {
        menu = menu.child(item("menu-resume", "Resume", false).on_press(|s: &mut State| s.act("resume")));
    }
    if running {
        menu = menu.child(item("menu-stop", "Stop session", false).on_press(|s: &mut State| s.act("stop")));
    }
    if stopped || failed {
        menu = menu.child(item("menu-delete", "Delete session", true).on_press(|s: &mut State| s.act("delete")));
    }
    let menu = menu.modal(true, |s: &mut State| {
        if let Some(c) = s.conn_mut() {
            c.menu = false;
        }
    });
    let top = crate::theme::BAR + HEADER - 6.0;
    layer.push(col().key("session-menu-layer").absolute(0.0, 0.0).w_full().h_full().pt(top).pr(14.0).items_end().child(menu));
}

fn confirm_delete(p: &Palette, layer: &mut Vec<El>) {
    let button = |key: &str, label: &str, danger: bool| {
        row()
            .key(key)
            .role("button")
            .label(label)
            .h(30.0)
            .px(14.0)
            .radius(RADIUS_MD)
            .center()
            .fill(if danger { p.danger } else { p.raised })
            .child(text(label.to_string()).font(META_STRONG).color(if danger { p.button_ink } else { p.ink }))
    };
    let dismiss = |s: &mut State| {
        if let Some(c) = s.conn_mut() {
            c.confirm_delete = false;
        }
    };
    let panel = col()
        .key("confirm-delete")
        .role("alertdialog")
        .label("Delete session")
        .w_full()
        .max_w(360.0)
        .padding(20.0)
        .gap(16.0)
        .radius(14.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .shadow(12.0, 32.0, p.shadow)
        .child(text("Delete this session and its history?").font(TITLE).color(p.ink).wrap())
        .child(row().w_full().gap(8.0).child(el().grow(1.0)).child(button("delete-cancel", "Cancel", false).on_press(dismiss)).child(button("delete-confirm", "Delete", true).on_press(|s: &mut State| s.act("delete"))))
        .modal(true, dismiss);
    layer.push(el().key("confirm-scrim").absolute(0.0, 0.0).w_full().h_full().fill(p.scrim).a11y_hidden());
    layer.push(col().key("confirm-layer").absolute(0.0, 0.0).w_full().h_full().padding(16.0).center().child(panel));
}

// ── Thread ─────────────────────────────────────────────────────────────────────────────────

fn placeholder(p: &Palette) -> El {
    let bar = |w: f32| el().w_frac(w).h(12.0).radius(6.0).fill(p.raised);
    col().w_full().gap(10.0).child(row().w_full().justify_end().child(el().w(260.0).h(40.0).radius(20.0).fill(p.raised))).child(bar(0.9)).child(bar(0.75)).child(bar(0.5))
}

fn thread(pg: &Page, mut inner: El, turns: &[Turn], mode: Mode) -> El {
    let p = pg.p;
    let hidden = if pg.conn.show_all { 0 } else { turns.len().saturating_sub(OPEN_TURNS) };
    if hidden > 0 {
        inner = inner.child(
            row()
                .key("earlier")
                .role("button")
                .label(&format!("{hidden} earlier {}", if hidden == 1 { "turn" } else { "turns" }))
                .h(30.0)
                .px(10.0)
                .gap(6.0)
                .radius(15.0)
                .center_y()
                .border(1.0, p.line)
                .hover(p.hover)
                .child(icon(&icons::CHEVRON_DOWN, 14.0).color(p.muted))
                .child(text(format!("{hidden} earlier {}", if hidden == 1 { "turn" } else { "turns" })).font(META).color(p.muted))
                .on_press(|s: &mut State| {
                    if let Some(c) = s.conn_mut() {
                        c.show_all = true;
                    }
                }),
        );
    }
    let shown = &turns[hidden..];
    for (i, turn) in shown.iter().enumerate() {
        let mode = if i + 1 == shown.len() { mode } else { Mode::Dormant };
        inner = inner.child(turn_view(pg, turn, mode));
    }
    inner
}

/// The answer is the turn's last final text; everything before it is the work log. A subagent's
/// tools sit under its row.
struct Split<'a> {
    log: Vec<&'a Item>,
    answer: String,
    children: Vec<(&'a str, Vec<&'a Tool>)>,
}

fn split(turn: &Turn) -> Split<'_> {
    let mut children: Vec<(&str, Vec<&Tool>)> = Vec::new();
    let mut items: Vec<&Item> = Vec::new();
    for item in &turn.items {
        match item {
            Item::Tool(t) if t.parent.is_some() => {
                let parent = t.parent.as_deref().unwrap_or("");
                match children.iter_mut().find(|(id, _)| *id == parent) {
                    Some((_, list)) => list.push(t),
                    None => children.push((parent, vec![t])),
                }
            }
            _ => items.push(item),
        }
    }
    let last = items.iter().rposition(|i| matches!(i, Item::Text { .. }));
    if let Some(at) = last {
        if let Item::Text { text, done, .. } = items[at] {
            if *done || turn.state != TurnState::Streaming {
                let answer = text.clone();
                items.remove(at);
                return Split { log: items, answer, children };
            }
        }
    }
    let answer = if items.is_empty() { turn.assistant.clone() } else { String::new() };
    Split { log: items, answer, children }
}

fn turn_view(pg: &Page, turn: &Turn, mode: Mode) -> El {
    let p = pg.p;
    let cut_off = mode == Mode::Dormant || (mode == Mode::Booting && (!turn.items.is_empty() || !turn.assistant.is_empty()));
    let state = if turn.state == TurnState::Streaming && cut_off { TurnState::Aborted } else { turn.state };
    let live = state == TurnState::Streaming;
    let parts = split(turn);
    let started = turn.started_at.as_deref().and_then(time::parse);
    let ended = turn.ended_at.as_deref().and_then(time::parse).or(if live { Some(pg.now) } else { None });
    let took = started.zip(ended).map(|(a, b)| time::duration(b - a));
    let steps = parts.log.iter().filter(|i| matches!(i, Item::Tool(_))).count();

    let mut col_ = col().key(&format!("turn:{}", turn.id)).w_full().gap(14.0).child(user_message(pg, turn));
    if live && mode == Mode::Booting {
        return col_;
    }
    if live {
        if !parts.log.is_empty() {
            col_ = col_.child(work_log(pg, &parts.log, &parts.children));
        }
        if !parts.answer.is_empty() {
            col_ = col_.child(Markdown::new(parts.answer.clone()).streaming(true).selectable(true).render(pg.md));
        }
        let mut live_row = row().key("live").gap(8.0).center_y().child(spinner(13.0, p.muted, pg.k)).child(breathing(text("Working").font(LOG).color(p.muted)));
        if let Some(took) = took {
            live_row = live_row.child(text(took).font(LOG).color(p.quiet));
        }
        return col_.child(live_row);
    }
    let errors: Vec<&Item> = parts.log.iter().copied().filter(|i| matches!(i, Item::Notice { tone, .. } if tone == "error")).collect();
    if !parts.log.is_empty() {
        let open = pg.opened("log", &turn.id);
        let key = pg.key("log", &turn.id);
        let mut worked = row()
            .key(&format!("worked:{}", turn.id))
            .role("button")
            .label("Work log")
            .gap(4.0)
            .center_y()
            .child(text(if state == TurnState::Completed { "Worked" } else { "Ran" }).font(LOG).color(p.muted));
        if let Some(took) = &took {
            worked = worked.child(text("for").font(LOG).color(p.muted)).child(text(took.clone()).font(rune::TextStyle { weight: 600.0, ..LOG }).color(p.muted));
        }
        if steps > 0 {
            worked = worked.child(text(format!("· {steps} {}", if steps == 1 { "step" } else { "steps" })).font(LOG).color(p.muted));
        }
        worked = worked.child(icon(if open { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 12.0).color(p.quiet)).on_press(move |s: &mut State| s.toggle(&key));
        col_ = col_.child(worked);
        if open {
            let log: Vec<&Item> = parts.log.iter().copied().filter(|i| !matches!(i, Item::Notice { tone, .. } if tone == "error")).collect();
            col_ = col_.child(work_log(pg, &log, &parts.children));
        }
    }
    for e in errors {
        if let Item::Notice { text: t, .. } = e {
            col_ = col_.child(notice(t, "error", p));
        }
    }
    if !parts.answer.is_empty() {
        col_ = col_.child(Markdown::new(parts.answer.clone()).selectable(true).render(pg.md));
    }
    for f in &turn.files {
        col_ = col_.child(row().gap(6.0).center_y().child(icon(&icons::FILE, 13.0).color(p.quiet)).child(text(f.caption.clone().unwrap_or_else(|| f.name.clone())).font(META).color(p.muted)));
    }
    let mut end = row().key(&format!("turn-end:{}", turn.id)).gap(6.0).center_y().min_h(24.0);
    match state {
        TurnState::Aborted => end = end.child(icon(&icons::STOP, 9.0).color(p.quiet)).child(text("Interrupted").font(SMALL).color(p.quiet)),
        TurnState::Failed => end = end.child(icon(&icons::ALERT, 13.0).color(p.danger)).child(text("Turn failed").font(SMALL).color(p.danger)),
        _ => {}
    }
    if !parts.answer.is_empty() {
        let answer = parts.answer.clone();
        end = end.child(el().grow(1.0)).child(
            icon_button(&format!("copy:{}", turn.id), &icons::COPY, "Copy answer", p).size(26.0, 26.0).on_press(move |_: &mut State| crate::copy(&answer)),
        );
    }
    col_.child(end)
}

fn user_message(pg: &Page, turn: &Turn) -> El {
    let p = pg.p;
    let long = turn.user.lines().count() > 8 || turn.user.chars().count() > 700;
    let open = pg.opened("user", &turn.id);
    let mut body = text(turn.user.clone()).font(BODY).color(p.ink).wrap().selectable(true);
    if long && !open {
        body = body.max_lines(8);
    }
    let mut bubble = col().max_w(THREAD_WIDTH * 0.85).px(16.0).py(10.0).radius(20.0).fill(p.raised).child(body);
    if long {
        let key = pg.key("user", &turn.id);
        bubble = bubble.child(
            text(if open { "Show less" } else { "Show more" })
                .key(&format!("more:{}", turn.id))
                .role("button")
                .font(META_STRONG)
                .color(p.muted)
                .pt(6.0)
                .on_press(move |s: &mut State| s.toggle(&key)),
        );
    }
    row().w_full().justify_end().child(bubble)
}

enum Entry<'a> {
    Explore(Vec<&'a Tool>),
    Item(&'a Item),
}

/// Runs of two or more read-only tools collapse into one explore line.
fn entries<'a>(items: &[&'a Item]) -> Vec<Entry<'a>> {
    let mut out: Vec<Entry> = Vec::new();
    for item in items {
        match item {
            Item::Tool(t) if t.category == "inspect" && t.status != "failed" => match out.last_mut() {
                Some(Entry::Explore(list)) => list.push(t),
                _ => out.push(Entry::Explore(vec![t])),
            },
            _ => out.push(Entry::Item(item)),
        }
    }
    out.into_iter()
        .map(|e| match e {
            Entry::Explore(list) if list.len() == 1 => Entry::Item(items.iter().copied().find(|i| i.id() == list[0].id).unwrap_or(items[0])),
            e => e,
        })
        .collect()
}

fn work_log(pg: &Page, items: &[&Item], children: &[(&str, Vec<&Tool>)]) -> El {
    let mut log = col().w_full().gap(2.0);
    for e in entries(items) {
        log = log.child(match e {
            Entry::Explore(tools) => explore(pg, &tools, children),
            Entry::Item(item) => log_item(pg, item, children),
        });
    }
    log
}

fn log_item(pg: &Page, item: &Item, children: &[(&str, Vec<&Tool>)]) -> El {
    let p = pg.p;
    match item {
        Item::Tool(t) => tool_row(pg, t, children),
        Item::Text { text: t, .. } if !t.is_empty() => col().w_full().py(4.0).child(Markdown::new(t.clone()).selectable(true).render(pg.md)),
        Item::Thinking { id, text: t } if !t.is_empty() => {
            let (title, body) = match t.strip_prefix("**").and_then(|r| r.split_once("**")) {
                Some((title, rest)) => (Some(title.to_string()), rest.trim_start().replace("**", "")),
                None => (None, t.replace("**", "")),
            };
            let open = pg.opened("thought", id);
            let key = pg.key("thought", id);
            let words = match title {
                Some(title) => format!("{title}. {body}"),
                None => body,
            };
            let mut line = text(words).font(LOG).color(p.quiet).wrap();
            if !open {
                line = line.max_lines(2);
            }
            row().key(&format!("thought:{id}")).role("button").label("Thought").w_full().py(4.0).child(line).on_press(move |s: &mut State| s.toggle(&key))
        }
        Item::Plan { steps, .. } => {
            let done = steps.iter().filter(|x| x.status == "completed").count();
            let mut plan = col()
                .w_full()
                .my(4.0)
                .px(12.0)
                .py(10.0)
                .gap(5.0)
                .radius(RADIUS)
                .border(1.0, p.line)
                .child(row().w_full().child(text("Plan").font(META_STRONG).color(p.ink).grow(1.0)).child(text(format!("{done}/{}", steps.len())).font(META).color(p.quiet)));
            for x in steps {
                let mark = match x.status.as_str() {
                    "completed" => icon(&icons::CHECK, 13.0).color(p.done),
                    "inProgress" => spinner(12.0, p.working, pg.k),
                    _ => icon(&icons::CIRCLE, 13.0).color(p.quiet),
                };
                let color = if x.status == "completed" { p.quiet } else { p.ink };
                plan = plan.child(row().w_full().gap(8.0).items_start().child(row().size(14.0, 18.0).center().child(mark)).child(text(x.step.clone()).font(LOG).color(color).wrap().grow(1.0).shrink()));
            }
            plan
        }
        Item::Notice { text: t, tone, .. } => notice(t, tone, p),
        _ => el(),
    }
}

fn notice(words: &str, tone: &str, p: &Palette) -> El {
    let error = tone == "error";
    let glyph = if error {
        &icons::ALERT
    } else if words.starts_with("Context") {
        &icons::COMPRESS
    } else {
        &icons::REFRESH
    };
    let color = if error { p.danger } else { p.muted };
    row().w_full().py(4.0).gap(8.0).items_start().child(row().size(14.0, 18.0).center().child(icon(glyph, 13.0).color(color))).child(text(words.to_string()).font(LOG).color(color).wrap().grow(1.0).shrink())
}

/// The web's tool tense table: summaries start with an imperative verb.
const TENSES: &[(&str, &str, &str)] = &[
    ("Read", "Reading", "Read"),
    ("Search", "Searching", "Searched"),
    ("List", "Listing", "Listed"),
    ("Explore", "Exploring", "Explored"),
    ("View", "Viewing", "Viewed"),
    ("Edit", "Editing", "Edited"),
    ("Create", "Creating", "Created"),
    ("Delete", "Deleting", "Deleted"),
    ("Write", "Writing", "Wrote"),
    ("Open", "Opening", "Opened"),
    ("Start", "Starting", "Started"),
    ("Message", "Messaging", "Messaged"),
    ("Wait", "Waiting", "Waited"),
    ("Update", "Updating", "Updated"),
    ("Run", "Running", "Ran"),
];

/// (verb, target, mono), as the web's `phrase`.
pub fn phrase(t: &Tool) -> (String, String, bool) {
    let running = t.status == "running";
    if t.name == "Agent" || t.name == "Task" {
        return (t.summary.clone(), String::new(), false);
    }
    if t.category == "run" || t.category == "check" {
        return ((if running { "Running" } else { "Ran" }).into(), t.summary.clone(), true);
    }
    if t.category == "research" && t.summary.contains(" · ") {
        return ((if running { "Calling" } else { "Called" }).into(), t.summary.clone(), false);
    }
    let (first, rest) = t.summary.split_once(' ').unwrap_or((t.summary.as_str(), ""));
    match TENSES.iter().find(|(w, _, _)| *w == first) {
        None => (t.summary.clone(), String::new(), false),
        Some((_, now, past)) => {
            let prose = ["Search", "Wait", "Start", "Message"].contains(&first);
            ((if running { *now } else { *past }).into(), rest.into(), !prose)
        }
    }
}

fn marker(running: bool, pg: &Page) -> El {
    let inner = if running { spinner(12.0, pg.p.muted, pg.k) } else { el().size(5.0, 5.0).radius(2.5).fill(pg.p.quiet) };
    row().size(14.0, 18.0).center().child(inner)
}

fn has_body(t: &Tool) -> bool {
    !t.changes.is_empty() || !t.output.is_empty() || !t.input.is_empty()
}

fn tool_row(pg: &Page, t: &Tool, children: &[(&str, Vec<&Tool>)]) -> El {
    let p = pg.p;
    let (verb, target, mono) = phrase(t);
    let kids: &[&Tool] = children.iter().find(|(id, _)| *id == t.id).map_or(&[], |(_, list)| list.as_slice());
    let expandable = has_body(t) || !kids.is_empty();
    let open = pg.opened("tool", &t.id);
    let running = t.status == "running";
    let failed = t.status == "failed" || t.exit_code.is_some_and(|c| c != 0);
    let mut line = row()
        .key(&format!("tool:{}", t.id))
        .role("button")
        .label(&format!("{verb} {target}"))
        .help(if t.input.is_empty() { t.summary.clone() } else { t.input.clone() })
        .w_full()
        .min_h(26.0)
        .px(4.0)
        .gap(6.0)
        .radius(6.0)
        .center_y()
        .child(marker(running, pg))
        .child(text(verb).font(LOG).color(if failed { p.danger } else { p.muted }));
    if !target.is_empty() {
        line = line.child(text(target).font(if mono { LOG_MONO } else { LOG }).color(p.ink).max_lines(1).shrink().min_w(0.0));
    }
    line = line.child(el().grow(1.0));
    if !kids.is_empty() {
        line = line.child(text(format!("{} {}", kids.len(), if kids.len() == 1 { "step" } else { "steps" })).font(SMALL).color(p.quiet));
    }
    if !running {
        if t.category == "change" {
            let (a, r) = t.changes.iter().map(diff::change_diff).fold((0, 0), |(a, r), f| (a + f.added, r + f.removed));
            line = line.child(diff_stat(a, r, p));
        }
        if let Some(code) = t.exit_code.filter(|c| *c != 0) {
            line = line.child(text(format!("exit {code}")).font(SMALL.mono()).color(p.danger));
        }
        if t.status == "declined" {
            line = line.child(text("Declined").font(SMALL).color(p.quiet));
        }
    }
    if expandable {
        let key = pg.key("tool", &t.id);
        line = line.child(icon(if open { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 12.0).color(p.quiet)).hover(p.hover).on_press(move |s: &mut State| s.toggle(&key));
    }
    let mut out = col().w_full().child(line);
    let group = |c: El| col().w_full().ml(10.0).pl(10.0).border_sides([1.0, 0.0, 0.0, 0.0], p.line).child(c);
    if running && !open {
        if let Some(current) = kids.last() {
            out = out.child(group(tool_row(pg, current, children)));
        }
    }
    if open && !kids.is_empty() {
        let mut list = col().w_full();
        for k in kids {
            list = list.child(tool_row(pg, k, children));
        }
        out = out.child(group(list));
    }
    if open && has_body(t) {
        out = out.child(tool_body(pg, t));
    }
    out
}

fn tool_body(pg: &Page, t: &Tool) -> El {
    let p = pg.p;
    if !t.changes.is_empty() {
        let mut body = col().w_full().my(4.0).radius(RADIUS_MD).clip_rounded(RADIUS_MD).border(1.0, p.line);
        for c in &t.changes {
            let file = diff::change_diff(c);
            if t.changes.len() > 1 {
                body = body.child(row().w_full().px(10.0).py(5.0).fill(p.sunken).child(text(c.path.clone()).font(CODE).color(p.muted)));
            }
            body = body.child(diff_lines(&file, Some(120), p));
        }
        return body;
    }
    let command = t.category == "run" || t.category == "check";
    let output = t.output.trim_start_matches('\n');
    let mut body = col().w_full().my(4.0).ml(6.0).pl(12.0).gap(6.0).border_sides([1.0, 0.0, 0.0, 0.0], p.line_strong);
    if !t.input.is_empty() {
        let shown = if command { format!("$ {}", t.input) } else { t.input.clone() };
        body = body.child(text(shown).font(CODE).color(p.ink).wrap().selectable(true));
    }
    if !output.is_empty() {
        let lines: Vec<&str> = output.split('\n').collect();
        let long = lines.len() > SHOWN_LINES + 2;
        let all = pg.opened("out", &t.id);
        let shown = if long && !all { lines[..SHOWN_LINES].join("\n") } else { output.to_string() };
        body = body.child(text(shown).font(CODE).color(p.muted).wrap().selectable(true));
        if long {
            let key = pg.key("out", &t.id);
            body = body.child(
                text(if all { "Show less".to_string() } else { format!("Show {} more lines", lines.len() - SHOWN_LINES) })
                    .role("button")
                    .font(META_STRONG)
                    .color(p.link)
                    .on_press(move |s: &mut State| s.toggle(&key)),
            );
        }
    }
    body
}

fn explore(pg: &Page, tools: &[&Tool], children: &[(&str, Vec<&Tool>)]) -> El {
    let p = pg.p;
    let running = tools.iter().any(|t| t.status == "running");
    let reads = tools.iter().filter(|t| t.summary.starts_with("Read") || t.summary.starts_with("View")).count();
    let searches = tools.iter().filter(|t| t.summary.starts_with("Search")).count();
    let other = tools.len() - reads - searches;
    let plural = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let mut parts = Vec::new();
    if reads > 0 {
        parts.push(plural(reads, "file", "files"));
    }
    if searches > 0 {
        parts.push(plural(searches, "search", "searches"));
    }
    if other > 0 {
        parts.push(plural(other, "listing", "listings"));
    }
    let id = tools[0].id.clone();
    let open = pg.opened("explore", &id);
    let key = pg.key("explore", &id);
    let line = row()
        .key(&format!("explore:{id}"))
        .role("button")
        .label("Explored")
        .w_full()
        .min_h(26.0)
        .px(4.0)
        .gap(6.0)
        .radius(6.0)
        .center_y()
        .hover(p.hover)
        .child(marker(running, pg))
        .child(text(if running { "Exploring" } else { "Explored" }).font(LOG).color(p.muted))
        .child(text(parts.join(", ")).font(LOG).color(p.ink))
        .child(el().grow(1.0))
        .child(icon(if open { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 12.0).color(p.quiet))
        .on_press(move |s: &mut State| s.toggle(&key));
    let mut out = col().w_full().child(line);
    if open {
        let mut list = col().w_full().ml(10.0).pl(10.0).border_sides([1.0, 0.0, 0.0, 0.0], p.line);
        for t in tools {
            list = list.child(tool_row(pg, t, children));
        }
        out = out.child(list);
    }
    out
}

const BOOT_STEPS: [&str; 3] = ["Starting the container", "Preparing the workspace", "Starting the agent"];

fn boot_steps(step: usize, pg: &Page) -> El {
    let p = pg.p;
    let mut list = col().key("boot-steps").w_full().gap(6.0);
    for (i, label) in BOOT_STEPS.iter().enumerate() {
        let (mark, color) = if i < step {
            (icon(&icons::CHECK, 13.0).color(p.done), p.quiet)
        } else if i == step {
            (spinner(12.0, p.working, pg.k), p.ink)
        } else {
            (icon(&icons::CIRCLE, 13.0).color(p.quiet), p.quiet)
        };
        list = list.child(row().gap(8.0).center_y().child(row().size(14.0, 18.0).center().child(mark)).child(text(*label).font(LOG).color(color)));
    }
    list
}

/// What happened to a session that isn't running, and the way back.
fn lifecycle(x: &Session, status: Status, pg: &Page) -> Option<El> {
    let p = pg.p;
    let resume = |busy: bool| {
        let mut b = row().key("resume").role("button").label("Resume").h(28.0).px(12.0).gap(6.0).radius(RADIUS_MD).center().fill(p.button);
        b = b.child(icon(&icons::PLAY, 10.0).color(p.button_ink)).child(text("Resume").font(META_STRONG).color(p.button_ink));
        if busy { b.opacity(0.5) } else { b.on_press(|s: &mut State| s.act("resume")) }
    };
    let (glyph, color, words, can_resume) = match status {
        Status::Asleep => (&icons::MOON, p.muted, "Asleep to save cost. Send a message or resume to wake it.".to_string(), true),
        Status::Stopped => {
            let loud = x.stop().is_some_and(|s| matches!(s.reason.as_str(), "crashed" | "stalled" | "gone"));
            (if loud { &icons::ALERT } else { &icons::STOP }, if loud { p.danger } else { p.muted }, format!("{} Send a message or resume to start it again.", api::stop_sentence(x.stop())), true)
        }
        Status::Failed => {
            let resumable = x.failure().is_some_and(|f| f.recovery == "resume");
            let tail = if resumable { " Its history is kept; resume to try again." } else { " Its history stays here; start a new session to try again." };
            (&icons::ALERT, p.danger, format!("{}{tail}", api::failure_sentence(x.failure())), resumable)
        }
        _ => return None,
    };
    let size = if status == Status::Stopped && !std::ptr::eq(glyph, &icons::ALERT) { 11.0 } else { 14.0 };
    let mut box_ = row()
        .key("lifecycle")
        .w_full()
        .px(14.0)
        .py(12.0)
        .gap(10.0)
        .radius(RADIUS)
        .border(1.0, p.line)
        .fill(p.surface)
        .items_start()
        .child(row().size(16.0, 20.0).center().child(icon(glyph, size).color(color)))
        .child(text(words).font(META).color(p.ink).wrap().grow(1.0).shrink().min_w(0.0).pt(1.0));
    if can_resume {
        box_ = box_.child(resume(pg.conn.busy));
    }
    Some(box_)
}

// ── Composer ───────────────────────────────────────────────────────────────────────────────

fn composer(pg: &Page, status: Option<Status>) -> El {
    let p = pg.p;
    let conn = pg.conn;
    let session = conn.session.as_ref();
    let failed = status == Some(Status::Failed);
    let stopped = matches!(status, Some(Status::Stopped | Status::Asleep));
    let working = status == Some(Status::Working);
    let resumable = stopped || (failed && session.and_then(|x| x.failure()).is_some_and(|f| f.recovery == "resume"));
    let disabled = failed || conn.conversation.is_none() || conn.missing;
    let placeholder = if failed {
        if resumable { "Resume to try again" } else { "This session can't take messages" }
    } else if stopped {
        "Send to resume…"
    } else if working {
        "Steer the agent…"
    } else {
        "Add a follow up…"
    };
    let mut input = text_input(&conn.draft, COMPOSER)
        .key(&format!("composer:{}", conn.id))
        .label("Message")
        .placeholder(placeholder, p.quiet)
        .color(p.ink)
        .w_full()
        .min_h(22.0)
        .max_h(220.0);
    if !disabled {
        input = input.on_edit(|s: &mut State| &mut s.conn_mut().expect("the composer's session is open").draft).on_submit(|s: &mut State, _| s.write("steer"));
    }
    let typed = !conn.draft.text.trim().is_empty();
    let round = |key: &str, label: &str, on: bool| {
        let b = el().key(key).role("button").label(label).help(label).size(30.0, 30.0).radius(15.0).center().fill(if on { p.button } else { p.raised });
        if on { b } else { b.opacity(0.6) }
    };
    let action = if working && !typed {
        round("stop-turn", "Stop", !conn.busy).child(el().size(9.0, 9.0).radius(2.0).fill(p.button_ink)).on_press(|s: &mut State| s.write("interrupt"))
    } else {
        let on = typed && !disabled && !conn.busy;
        let b = round("send", "Send", on).child(icon(&icons::ARROW_UP, 15.0).color(if on { p.button_ink } else { p.quiet }));
        if on { b.on_press(|s: &mut State| s.write("steer")) } else { b }
    };
    let agent = session.map_or("codex", |x| x.display.agent_kind.as_str());
    let chip = row().h(24.0).px(8.0).radius(12.0).center().border(1.0, p.line).child(text(api::agent_name(agent)).font(PILL).color(p.muted));
    let boxed = col()
        .key("composer-box")
        .w_full()
        .max_w(THREAD_WIDTH)
        .min_h(54.0)
        .pl(16.0)
        .pr(8.0)
        .pt(12.0)
        .pb(8.0)
        .gap(6.0)
        .radius(23.0)
        .fill(p.surface)
        .border(1.0, p.line_strong)
        .shadow(6.0, 20.0, p.shadow)
        .opacity(if disabled { 0.7 } else { 1.0 })
        .child(input)
        .child(row().w_full().gap(8.0).center_y().child(chip).child(el().grow(1.0)).child(action));
    let mut dock = col().key("composer-dock").w_full().items_center().px(GUTTER).pt(4.0).pb(16.0).gap(6.0);
    let link_note = if conn.missing {
        Some("Session not found")
    } else if !conn.live() {
        None
    } else {
        match conn.link {
            Link::Connecting if conn.conversation.is_none() => Some("Connecting…"),
            Link::Retrying(_) => Some("Reconnecting…"),
            Link::Closed => Some("Disconnected; reload to reconnect"),
            _ => None,
        }
    };
    let alert = if conn.error.is_empty() { link_note.map(str::to_string) } else { Some(conn.error.clone()) };
    if let Some(alert) = alert {
        dock = dock.child(note_row(&alert, true, p));
    } else if !conn.note.is_empty() {
        dock = dock.child(note_row(&conn.note, false, p));
    }
    dock.child(boxed)
}

fn note_row(words: &str, alert: bool, p: &Palette) -> El {
    let color = if alert { p.danger } else { p.muted };
    row()
        .key("composer-note")
        .role(if alert { "alert" } else { "status" })
        .w_full()
        .max_w(THREAD_WIDTH)
        .px(16.0)
        .gap(6.0)
        .center_y()
        .child(icon(if alert { &icons::ALERT } else { &icons::CHECK }, 13.0).color(color))
        .child(text(words.to_string()).font(META).color(color).max_lines(2))
}

// ── Changes ────────────────────────────────────────────────────────────────────────────────

pub fn diff_stat(added: usize, removed: usize, p: &Palette) -> El {
    let mut r = row().gap(6.0).center_y();
    if added > 0 {
        r = r.child(text(format!("+{}", diff::compact(added))).font(SMALL.mono()).color(p.diff_add));
    }
    if removed > 0 {
        r = r.child(text(format!("−{}", diff::compact(removed))).font(SMALL.mono()).color(p.diff_del));
    }
    r
}

fn changes_panel(pg: &Page, changes: &[FileDiff]) -> El {
    let p = pg.p;
    let mut body = col().w_full();
    if changes.is_empty() {
        body = body.child(col().w_full().py(48.0).center().gap(6.0).child(icon(&icons::DIFF, 18.0).color(p.quiet)).child(text("No changes yet").font(META).color(p.quiet)));
    } else {
        let added: usize = changes.iter().map(|f| f.added).sum();
        let removed: usize = changes.iter().map(|f| f.removed).sum();
        body = body.child(
            row()
                .key("diff-summary")
                .w_full()
                .h(40.0)
                .px(14.0)
                .gap(10.0)
                .center_y()
                .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
                .child(text(format!("{} {} changed", changes.len(), if changes.len() == 1 { "file" } else { "files" })).font(META_STRONG).color(p.ink))
                .child(diff_stat(added, removed, p)),
        );
        // A short list opens every file; a long one starts shut. Clicking a head flips it.
        let start_open = changes.len() <= 6;
        for f in changes {
            let open = start_open != pg.opened("file", &f.path);
            body = body.child(diff_file(pg, f, open));
        }
    }
    col()
        .key("changes")
        .role("region")
        .label("Changes")
        .w_frac(0.44)
        .min_w(360.0)
        .h_full()
        .fill(p.bg)
        .border_sides([1.0, 0.0, 0.0, 0.0], p.line)
        .child(row().w_full().h(36.0).px(14.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], p.line).child(text("Changes").font(META_STRONG).color(p.ink).grow(1.0)).child(icon_button("close-changes", &icons::X, "Close", p).size(26.0, 26.0).on_press(|s: &mut State| s.panel = false)))
        .child(col().key(&format!("changes-scroll:{}", pg.conn.id)).w_full().grow(1.0).shrink().min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(body))
}

fn diff_file(pg: &Page, f: &FileDiff, open: bool) -> El {
    let p = pg.p;
    let glyph = match f.kind.as_str() {
        "add" => &icons::FILE_PLUS,
        "delete" => &icons::FILE_MINUS,
        _ => &icons::FILE,
    };
    let (dir, name) = match f.path.rfind('/') {
        Some(at) => (&f.path[..=at], &f.path[at + 1..]),
        None => ("", f.path.as_str()),
    };
    let key = pg.key("file", &f.path);
    let head = row()
        .key(&format!("file:{}", f.path))
        .role("button")
        .label(&f.path)
        .w_full()
        .h(34.0)
        .px(10.0)
        .gap(6.0)
        .center_y()
        .fill(p.sunken)
        .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
        .hover(p.hover)
        .child(icon(if open { &icons::CHEVRON_DOWN } else { &icons::CHEVRON_RIGHT }, 12.0).color(p.quiet))
        .child(icon(glyph, 14.0).color(p.muted))
        .child(row().shrink().min_w(0.0).child(text(dir.to_string()).font(CODE).color(p.quiet).max_lines(1).shrink().min_w(0.0)).child(text(name.to_string()).font(rune::TextStyle { weight: 600.0, ..CODE }).color(p.ink).max_lines(1)))
        .child(el().grow(1.0))
        .child(diff_stat(f.added, f.removed, p))
        .on_press(move |s: &mut State| s.toggle(&key));
    let mut out = col().w_full().child(head);
    if open {
        out = out.child(diff_lines(f, Some(400), p));
    }
    out
}

/// Numbered lines on add/remove tints; unchanged runs over 8 fold to 3 either side.
fn diff_lines(f: &FileDiff, limit: Option<usize>, p: &Palette) -> El {
    let mut out = col().w_full().py(2.0);
    let shown = diff::fold(&f.lines);
    let total = shown.len();
    let cap = limit.unwrap_or(usize::MAX);
    let num = |n: Option<u64>| row().w(34.0).min_w(34.0).pr(4.0).justify_end().child(text(n.map_or(String::new(), |n| n.to_string())).font(SMALL.mono()).color(p.quiet).pt(2.0));
    for (i, s) in shown.iter().enumerate() {
        if i == cap {
            out = out.child(row().w_full().px(12.0).py(6.0).child(text(format!("{} more lines", total - cap)).font(SMALL).color(p.quiet)));
            break;
        }
        out = out.child(match s {
            Shown::Fold(n) => row().w_full().h(24.0).px(12.0).center_y().fill(p.sunken).child(text(format!("{n} unchanged lines")).font(SMALL).color(p.quiet)),
            Shown::Line(l) if l.kind == LineKind::Hunk => row().w_full().h(22.0).px(12.0).center_y().fill(p.sunken).child(text(l.text.clone()).font(SMALL.mono()).color(p.quiet).max_lines(1)),
            Shown::Line(l) => {
                let (bg, mark, ink) = match l.kind {
                    LineKind::Add => (Some(p.diff_add_bg), "+", p.diff_add),
                    LineKind::Del => (Some(p.diff_del_bg), "−", p.diff_del),
                    _ => (None, " ", p.quiet),
                };
                let mut r = row().w_full().min_h(18.0).items_start().child(num(l.old)).child(num(l.new)).child(row().w(16.0).min_w(16.0).justify_center().child(text(mark).font(CODE).color(ink))).child(text(l.text.clone()).font(CODE).color(p.ink).wrap().grow(1.0).shrink().min_w(0.0).pr(10.0));
                if let Some(bg) = bg {
                    r = r.fill(bg);
                }
                r
            }
        });
    }
    out
}
