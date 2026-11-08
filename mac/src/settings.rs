//! The Settings window (⌘,): the web's sections (`ui/src/components/Settings.tsx`) in a left nav,
//! one page at a time on the right, every word the web's. It loads what it shows from the Scotty
//! the main window has open; the main window tells it which one (`connect`).
//!
//! What it does here: reads every section, saves Instructions, clears a repository's size, and
//! signs out. Signing in to ChatGPT, adding a token, and editing connections and blueprints open
//! the web's own page in the browser, so no token is typed into this app.

use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};

use rune::{AppHandle, AppSpec, Cx, El, ScrollSpec, TextEdit, Tx, Waker, col, el, icon, row, text, text_input};

use crate::api::{self, Answer, Credential, RepoSize};
use crate::theme::{self, META, META_STRONG, PAGE_TITLE, Palette, RADIUS, RADIUS_MD, ROW, ROW_STRONG, SMALL, icons};
use crate::{Appearance, encode, offline, palette::open_url};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Accounts,
    Instructions,
    Skills,
    Repositories,
    Connections,
    Blueprints,
    Running,
    SignedIn,
}

pub struct Page {
    pub id: &'static str,
    pub label: &'static str,
    pub detail: &'static str,
    pub section: Section,
    pub icon: &'static rune::Icon,
}

pub const PAGES: [Page; 8] = [
    Page { id: "accounts", label: "Accounts", detail: "ChatGPT, Claude and GitHub", section: Section::Accounts, icon: &icons::GLOBE },
    Page { id: "instructions", label: "Instructions", detail: "Added to every session", section: Section::Instructions, icon: &icons::FILE },
    Page { id: "skills", label: "Skills", detail: "Installed in new sessions", section: Section::Skills, icon: &icons::LIST },
    Page { id: "repositories", label: "Repositories", detail: "The size new sessions get", section: Section::Repositories, icon: &icons::REPO },
    Page { id: "connections", label: "Connections", detail: "Webhooks, API tokens and MCP servers", section: Section::Connections, icon: &icons::BRANCH },
    Page { id: "blueprints", label: "Blueprints", detail: "Connections and automations for one use", section: Section::Blueprints, icon: &icons::NODES },
    Page { id: "running", label: "Running", detail: "Sessions running and the cap", section: Section::Running, icon: &icons::PLAY },
    Page { id: "signed-in", label: "Signed in", detail: "Cloudflare Access", section: Section::SignedIn, icon: &icons::CIRCLE },
];

fn page_of(section: Section) -> &'static Page {
    PAGES.iter().find(|p| p.section == section).unwrap_or(&PAGES[0])
}

/// The size a repository without a default starts at (`src/places/place.ts` `defaultSize`).
const DEFAULT_SIZE: &str = "standard-1";

enum Ask {
    Settings,
    /// 0 ChatGPT, 1 Claude, 2 GitHub.
    Credential(usize),
    Repos,
    SaveInstructions(String),
    ClearRepo(String),
}

pub struct State {
    pub section: Section,
    pub appearance: Appearance,
    base: Option<String>,
    main: Option<AppHandle<crate::State>>,
    pub settings: Option<api::Settings>,
    pub accounts: [Option<Credential>; 3],
    pub repos: Option<Vec<RepoSize>>,
    pub error: String,
    pub instructions: TextEdit,
    pub saving: bool,
    pub saved: bool,
    pub problem: String,
    pub busy_repo: Option<String>,
    waker: Option<Waker>,
    wake: Waker,
    wake_slot: Arc<Mutex<Option<Waker>>>,
    http: (Sender<(Ask, Answer)>, Receiver<(Ask, Answer)>),
}

impl State {
    pub fn new(main: Option<AppHandle<crate::State>>) -> State {
        let wake_slot: Arc<Mutex<Option<Waker>>> = Default::default();
        let slot = wake_slot.clone();
        let wake: Waker = Arc::new(move || {
            if let Some(w) = slot.lock().ok().and_then(|w| w.clone()) {
                w();
            }
        });
        State {
            section: Section::Accounts,
            appearance: Appearance::System,
            base: None,
            main,
            settings: None,
            accounts: [None, None, None],
            repos: None,
            error: String::new(),
            instructions: TextEdit::new(""),
            saving: false,
            saved: false,
            problem: String::new(),
            busy_repo: None,
            waker: None,
            wake,
            wake_slot,
            http: std::sync::mpsc::channel(),
        }
    }

    /// The main window opened `base`: forget the last Scotty's settings and read this one's.
    pub fn connect(&mut self, base: String) {
        let main = self.main.take();
        let (section, appearance) = (self.section, self.appearance);
        let waker = self.waker.take();
        let wake_slot = self.wake_slot.clone();
        *self = State { section, appearance, main, waker, ..State::new(None) };
        // Keep the one wake slot the window's waker was stored in.
        self.wake_slot = wake_slot.clone();
        self.wake = Arc::new(move || {
            if let Some(w) = wake_slot.lock().ok().and_then(|w| w.clone()) {
                w();
            }
        });
        self.base = Some(base);
        self.load();
    }

    fn ask(&self, method: &'static str, path: String, body: Option<String>, tag: Ask) {
        let (Some(base), Some(_)) = (&self.base, &self.waker) else { return };
        let wake = self.wake.clone();
        api::call(base.clone(), method, path, body, tag, self.http.0.clone(), move || wake());
    }

    fn load(&mut self) {
        self.ask("GET", "/api/settings".into(), None, Ask::Settings);
        for (i, name) in ["chatgpt", "claude", "github"].iter().enumerate() {
            self.ask("GET", format!("/api/credentials/{name}"), None, Ask::Credential(i));
        }
        self.ask("GET", "/api/repos".into(), None, Ask::Repos);
    }

    fn save_instructions(&mut self) {
        if self.saving {
            return;
        }
        let text = self.instructions.text.clone();
        self.saving = true;
        self.problem.clear();
        self.ask("PUT", "/api/settings/instructions".into(), Some(format!(r#"{{"text":{}}}"#, api::json_str(&text))), Ask::SaveInstructions(text));
    }

    fn clear_repo(&mut self, repo: String) {
        if self.busy_repo.is_some() {
            return;
        }
        self.busy_repo = Some(repo.clone());
        self.problem.clear();
        let path = format!("/api/repos/{}", repo.split('/').map(encode).collect::<Vec<_>>().join("/"));
        self.ask("DELETE", path, None, Ask::ClearRepo(repo));
    }

    /// Open this section of the web's Settings in the browser.
    fn browse(&self, page: &str) {
        if let Some(base) = &self.base {
            open_url(&format!("{base}/settings/{page}"));
        }
    }

    fn sign_out(&mut self) {
        if let Some(main) = &self.main {
            main.update(|s, _| s.sign_out());
        }
        *self = State { section: self.section, appearance: self.appearance, main: self.main.take(), waker: self.waker.take(), wake: self.wake.clone(), wake_slot: self.wake_slot.clone(), ..State::new(None) };
    }

    fn answer(&mut self, ask: Ask, answer: Answer) {
        match ask {
            Ask::Settings => match answer.map(|b| serde_json::from_str::<api::Settings>(&b)) {
                Ok(Ok(settings)) => {
                    if !self.saving && self.instructions.text == self.settings.as_ref().map_or(String::new(), |s| s.instructions.clone()) {
                        self.instructions = TextEdit::new(&settings.instructions);
                    }
                    self.settings = Some(settings);
                }
                Ok(Err(_)) => self.error = "Could not load settings".into(),
                Err(f) => self.error = if f.message.is_empty() { "Could not load settings".into() } else { f.message },
            },
            Ask::Credential(i) => match answer.map(|b| serde_json::from_str::<Credential>(&b)) {
                Ok(Ok(c)) => self.accounts[i] = Some(c),
                Ok(Err(_)) => self.error = "Could not load settings".into(),
                Err(f) => self.error = f.message,
            },
            Ask::Repos => match answer.map(|b| serde_json::from_str::<api::Repos>(&b)) {
                Ok(Ok(r)) => self.repos = Some(r.repos),
                Ok(Err(_)) => self.problem = "Could not load repositories".into(),
                Err(f) => self.problem = f.message,
            },
            Ask::SaveInstructions(text) => {
                self.saving = false;
                match answer {
                    Ok(_) => {
                        self.saved = self.instructions.text == text;
                        if let Some(s) = self.settings.as_mut() {
                            s.instructions = text;
                        }
                    }
                    Err(f) => self.problem = if f.message.is_empty() { "Could not save".into() } else { f.message },
                }
            }
            Ask::ClearRepo(repo) => {
                self.busy_repo = None;
                match answer {
                    Ok(_) => {
                        if let Some(list) = self.repos.as_mut() {
                            list.retain(|r| r.repo != repo);
                        }
                    }
                    Err(f) => self.problem = if f.message.is_empty() { "Could not save".into() } else { f.message },
                }
            }
        }
    }
}

fn setup(state: &mut State, waker: Waker) {
    if let Ok(mut slot) = state.wake_slot.lock() {
        *slot = Some(waker.clone());
    }
    if offline() {
        return;
    }
    state.waker = Some(waker);
    if state.base.is_some() && state.settings.is_none() {
        state.load();
    }
}

fn poll(state: &mut State, _clock: f64, _tx: &mut Tx) -> bool {
    let mut changed = false;
    while let Ok((ask, answer)) = state.http.1.try_recv() {
        state.answer(ask, answer);
        changed = true;
    }
    changed
}

pub fn spec() -> AppSpec<State> {
    AppSpec {
        min_size: Some((620.0, 420.0)),
        families: (theme::SANS, "ui-monospace"),
        scenes: SCENES,
        setup: Some(setup),
        poll: Some(poll),
        ..AppSpec::new("Settings", (760.0, 560.0), || State::new(None), view)
    }
}

// ── View ───────────────────────────────────────────────────────────────────────────────────

pub fn view(s: &State, cx: &mut Cx<State>) -> El {
    let dark = match s.appearance {
        Appearance::System => cx.system_dark(),
        Appearance::Light => false,
        Appearance::Dark => true,
    };
    let p = theme::palette(dark);
    let inset = cx.titlebar_inset();
    let mut nav = col().key("settings-nav").role("navigation").label("Settings").w(224.0).h_full().px(10.0).pb(12.0).gap(2.0).fill(p.sidebar).border_sides([0.0, 1.0, 0.0, 0.0], p.line);
    nav = nav.child(row().w_full().h(inset.max(28.0) + 10.0).window_drag());
    for page in &PAGES {
        let current = page.section == s.section;
        let section = page.section;
        let mut item = row()
            .key(&format!("nav:{}", page.id))
            .role("link")
            .label(page.label)
            .w_full()
            .px(10.0)
            .py(7.0)
            .gap(10.0)
            .radius(RADIUS_MD)
            .center_y()
            .hover(p.hover)
            .child(icon(page.icon, 15.0).color(if current { p.ink } else { p.muted }))
            .child(col().grow(1.0).shrink().min_w(0.0).child(text(page.label).font(if current { ROW_STRONG } else { ROW }).color(p.ink)).child(text(page.detail).font(SMALL).color(p.quiet).max_lines(1)))
            .on_press(move |s: &mut State| s.section = section);
        if current {
            item = item.fill(p.selected);
        }
        nav = nav.child(item);
    }
    let page = page_of(s.section);
    let mut body = col().key(&format!("settings-body:{}", page.id)).w_full().max_w(560.0).gap(14.0).child(text(page.label).font(PAGE_TITLE).color(p.ink));
    if !s.error.is_empty() {
        body = body.child(notice(&s.error, &p));
    }
    let base = s.base.is_some();
    let loaded = s.settings.is_some() && s.accounts.iter().all(Option::is_some);
    body = if !base {
        body.child(card(&p).child(row_(&p, "No Scotty open", "Open one in the main window to see its settings.", None)))
    } else if !loaded && !matches!(s.section, Section::Connections | Section::Blueprints) {
        if s.error.is_empty() { body.child(skeleton(&p)) } else { body }
    } else {
        match s.section {
            Section::Accounts => accounts(s, body, &p),
            Section::Instructions => instructions(s, body, &p),
            Section::Skills => skills(s, body, &p),
            Section::Repositories => repositories(s, body, &p),
            Section::Connections => browser_page(
                body,
                "A connection lets an outside service start sessions with a signed webhook, or lets agents call an API or MCP server through its internal URL.",
                "connections",
                &p,
            ),
            Section::Blueprints => browser_page(body, "A blueprint adds the connections and automations for one use, all off. Choose the repo and agent, paste the secrets it asks for, and install; then paste the URLs where it says and turn the automations on.", "blueprints", &p),
            Section::Running => running(s, body, &p),
            Section::SignedIn => signed_in(s, body, &p),
        }
    };
    let main = col()
        .key("settings-page")
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .h_full()
        .fill(p.bg)
        .child(row().w_full().h(inset.max(28.0) + 10.0).window_drag())
        .child(col().key(&format!("settings-scroll:{}", page.id)).w_full().grow(1.0).shrink().min_h(0.0).scroll(ScrollSpec { stick_bottom: false }).child(row().w_full().justify_center().px(32.0).pb(32.0).child(body)));
    row().w_full().h_full().fill(p.bg).child(nav).child(main)
}

fn card(p: &Palette) -> El {
    col().w_full().radius(RADIUS).clip_rounded(RADIUS).fill(p.surface).border(1.0, p.line)
}

#[derive(Clone, Copy)]
enum Tone {
    Good,
    Warn,
}

/// The web's settings `Row`: a title and a detail, a status word, then its controls.
fn row_(p: &Palette, title: &str, detail: &str, status: Option<(&str, Tone)>) -> El {
    let mut r = row()
        .w_full()
        .px(16.0)
        .py(12.0)
        .gap(12.0)
        .center_y()
        .child(col().grow(1.0).shrink().min_w(0.0).gap(2.0).child(text(title.to_string()).font(ROW_STRONG).color(p.ink).wrap()).child(text(detail.to_string()).font(META).color(p.muted).wrap()));
    if let Some((word, tone)) = status {
        let color = match tone {
            Tone::Good => p.done,
            Tone::Warn => p.warning,
        };
        r = r.child(text(word.to_string()).font(META_STRONG).color(color));
    }
    r
}

fn divider(p: &Palette) -> El {
    el().w_full().h(1.0).fill(p.line)
}

fn button(key: &str, label: &str, primary: bool, p: &Palette) -> El {
    row()
        .key(key)
        .role("button")
        .label(label)
        .h(28.0)
        .px(12.0)
        .gap(6.0)
        .radius(RADIUS_MD)
        .center()
        .fill(if primary { p.button } else { p.raised })
        .border(1.0, if primary { p.button } else { p.line })
        .child(text(label.to_string()).font(META_STRONG).color(if primary { p.button_ink } else { p.ink }))
}

fn intro(words: &str, p: &Palette) -> El {
    text(words.to_string()).font(META).color(p.muted).wrap()
}

fn notice(words: &str, p: &Palette) -> El {
    row().key("settings-error").role("alert").w_full().gap(6.0).center_y().child(icon(&icons::ALERT, 13.0).color(p.danger)).child(text(words.to_string()).font(META).color(p.danger).wrap().grow(1.0).shrink())
}

fn skeleton(p: &Palette) -> El {
    card(p).child(col().w_full().px(16.0).py(14.0).gap(8.0).child(el().w_frac(0.4).h(12.0).radius(6.0).fill(p.raised)).child(el().w_frac(0.7).h(10.0).radius(5.0).fill(p.raised)))
}

fn accounts(s: &State, body: El, p: &Palette) -> El {
    let status = |i: usize| s.accounts[i].as_ref().map_or("signed-out", |c| c.status.as_str());
    let chatgpt = status(0);
    let claude = status(1);
    let github = s.accounts[2].as_ref();
    let browse = |key: &str, label: &str| button(key, label, false, p).help("Opens Settings in the browser").on_press(|s: &mut State| s.browse("accounts"));
    let chatgpt_row = row_(
        p,
        "ChatGPT",
        match chatgpt {
            "signed-in" => "Signed in. Codex runs on this account.",
            "expiring" => "Sign-in expires soon; sign in again.",
            _ => "Not signed in. Codex sessions can't start until you are.",
        },
        Some(match chatgpt {
            "signed-in" => ("Signed in", Tone::Good),
            "expiring" => ("Expires soon", Tone::Warn),
            _ => ("Not signed in", Tone::Warn),
        }),
    )
    .child(browse("chatgpt-sign-in", if chatgpt == "signed-in" { "Sign in again" } else { "Sign in" }));
    let claude_row = row_(
        p,
        "Claude",
        match claude {
            "signed-in" => "Token set. Claude sessions run on your subscription.",
            "expiring" => "Token expires soon; add a new one.",
            _ => "No token. Run claude setup-token and paste what it prints.",
        },
        Some(match claude {
            "signed-in" => ("Set", Tone::Good),
            "expiring" => ("Expires soon", Tone::Warn),
            _ => ("Not set", Tone::Warn),
        }),
    )
    .child(browse("claude-token", if claude == "signed-out" { "Add token" } else { "Replace" }));
    let set = github.is_some_and(|g| g.status == "set");
    let login = github.and_then(|g| g.login.clone()).unwrap_or_else(|| "your account".into());
    let github_detail = if set { format!("Token for {login}. Sessions push branches with it.") } else { "No token. Sessions can clone only the built-in fixture.".into() };
    let github_row = row_(p, "GitHub", &github_detail, Some(if set { ("Set", Tone::Good) } else { ("Not set", Tone::Warn) })).child(browse("github-token", if set { "Replace" } else { "Add token" }));
    body.child(card(p).child(chatgpt_row).child(divider(p)).child(claude_row).child(divider(p)).child(github_row))
        .child(text("Sign-ins and tokens are entered in the browser, so this app never holds them.").font(SMALL).color(p.quiet).wrap())
}

fn instructions(s: &State, body: El, p: &Palette) -> El {
    let saved = s.settings.as_ref().map_or("", |x| x.instructions.as_str());
    let changed = s.instructions.text != saved;
    let field = text_input(&s.instructions, crate::theme::CODE.lh(20.0))
        .key("instructions")
        .label("Instructions")
        .placeholder("Prefer small commits. Run the tests before you finish.", p.quiet)
        .color(p.ink)
        .w_full()
        .on_edit(|s: &mut State| {
            s.saved = false;
            &mut s.instructions
        });
    let boxed = col().w_full().min_h(200.0).padding(12.0).radius(RADIUS).fill(p.surface).border(1.0, p.line_strong).child(field);
    let mut actions = row().w_full().gap(10.0).center_y().child(el().grow(1.0));
    if s.saved && !changed {
        actions = actions.child(row().gap(5.0).center_y().child(icon(&icons::CHECK, 13.0).color(p.quiet)).child(text("Saved").font(META).color(p.quiet)));
    }
    let on = changed && !s.saving;
    let mut save = button("save-instructions", "Save", true, p);
    save = if on { save.on_press(|s: &mut State| s.save_instructions()) } else { save.opacity(0.5) };
    let mut body = body.child(intro("Added to the agent's AGENTS.md when a session starts or resumes. Running sessions keep what they started with.", p)).child(boxed).child(actions.child(save));
    if !s.problem.is_empty() {
        body = body.child(notice(&s.problem, p));
    }
    body
}

fn skills(s: &State, body: El, p: &Palette) -> El {
    let Some(settings) = &s.settings else { return body };
    let mut body = body;
    if let Some(style) = &settings.claude_style {
        body = body.child(card(p).child(row_(p, "Claude output style", style, None)));
    }
    if settings.sources.is_empty() {
        body = body.child(card(p).child(row_(p, "No skills", "Add a GitHub repository with skills to install them in new sessions.", None)));
    }
    for source in &settings.sources {
        let on = source.skills.iter().filter(|x| x.enabled).count();
        let mut c = card(p).child(
            row()
                .w_full()
                .px(16.0)
                .py(10.0)
                .gap(6.0)
                .center_y()
                .fill(p.sunken)
                .child(text(source.id.clone()).font(ROW_STRONG).color(p.ink))
                .child(text(source.reference.as_ref().map_or(String::new(), |r| format!("@{r}"))).font(META).color(p.quiet))
                .child(el().grow(1.0))
                .child(text(format!("{on} of {}", source.skills.len())).font(META).color(p.quiet)),
        );
        for skill in &source.skills {
            let mut title = row().gap(6.0).center_y().child(text(skill.name.clone()).font(crate::theme::CODE).color(p.ink));
            if skill.manual {
                title = title.child(text("manual").font(SMALL).color(p.quiet));
            }
            let mut r = row()
                .w_full()
                .px(16.0)
                .py(10.0)
                .gap(12.0)
                .center_y()
                .border_sides([1.0, 0.0, 0.0, 0.0], p.line)
                .child(col().grow(1.0).shrink().min_w(0.0).gap(2.0).child(title).child(text(skill.description.clone()).font(META).color(p.muted).max_lines(2)))
                .child(switch(skill.enabled, p));
            if !skill.enabled {
                r = r.opacity(0.6);
            }
            c = c.child(r);
        }
        body = body.child(c);
    }
    body.child(row().w_full().child(el().grow(1.0)).child(button("skills-browser", "Manage in the browser", false, p).on_press(|s: &mut State| s.browse("skills"))))
}

/// A read-only switch, as the web draws its skill toggles.
fn switch(on: bool, p: &Palette) -> El {
    let track = row().w(30.0).h(18.0).radius(9.0).px(2.0).center_y().fill(if on { p.accent } else { p.line_strong });
    let knob = el().size(14.0, 14.0).radius(7.0).fill(p.button_ink);
    if on { track.child(el().grow(1.0)).child(knob) } else { track.child(knob) }.role("switch").label(if on { "On" } else { "Off" })
}

fn repositories(s: &State, body: El, p: &Palette) -> El {
    let mut c = card(p);
    match &s.repos {
        None if s.problem.is_empty() => c = c.child(col().w_full().px(16.0).py(14.0).child(el().w_frac(0.5).h(12.0).radius(6.0).fill(p.raised))),
        None => {}
        Some(list) if list.is_empty() => c = c.child(row_(p, "No defaults", &format!("Every new session starts at {DEFAULT_SIZE}."), None)),
        Some(list) => {
            for (i, item) in list.iter().enumerate() {
                if i > 0 {
                    c = c.child(divider(p));
                }
                let repo = item.repo.clone();
                let busy = s.busy_repo.as_deref() == Some(item.repo.as_str());
                let mut clear = button(&format!("clear:{}", item.repo), "Clear", false, p).label(&format!("Clear {}", item.repo));
                clear = if s.busy_repo.is_some() { clear.opacity(0.5) } else { clear.on_press(move |s: &mut State| s.clear_repo(repo.clone())) };
                let size = row().h(28.0).px(10.0).radius(RADIUS_MD).center().border(1.0, p.line).child(text(item.size.clone()).font(crate::theme::CODE).color(p.ink));
                c = c.child(row_(p, &item.repo, if busy { "Clearing…" } else { "New sessions start at this size" }, None).child(size).child(clear));
            }
        }
    }
    let mut body = body.child(intro("New sessions on a repository start at its size unless they pick one. A session keeps the size it was made at.", p)).child(c);
    if !s.problem.is_empty() {
        body = body.child(notice(&s.problem, p));
    }
    body.child(row().w_full().child(el().grow(1.0)).child(button("repos-browser", "Set a size in the browser", false, p).on_press(|s: &mut State| s.browse("repositories"))))
}

fn browser_page(body: El, words: &str, page: &'static str, p: &Palette) -> El {
    body.child(intro(words, p)).child(
        card(p).child(
            row_(p, "Open in the browser", "Editing these needs the web's forms. They open on your Scotty's own Settings page.", None)
                .child(button(&format!("{page}-browser"), "Open", true, p).child(icon(&icons::EXTERNAL, 12.0).color(p.button_ink)).on_press(move |s: &mut State| s.browse(page))),
        ),
    )
}

fn running(s: &State, body: El, p: &Palette) -> El {
    let Some(x) = &s.settings else { return body };
    let full = x.running >= x.max_running;
    body.child(card(p).child(row_(
        p,
        &format!("{} of {} running", x.running, x.max_running),
        if full {
            "The cap is full: a new or resumed session stops until one ends. Raise maxRunning in the stage config and deploy to allow more."
        } else {
            "Each session with a container holds a slot until it stops or sleeps. maxRunning in the stage config sets the cap."
        },
        Some(if full { ("Full", Tone::Warn) } else { ("Room left", Tone::Good) }),
    )))
}

fn signed_in(s: &State, body: El, p: &Palette) -> El {
    let email = s.settings.as_ref().and_then(|x| x.email.clone()).unwrap_or_else(|| "Unknown account".into());
    let host = s.base.as_deref().unwrap_or("").trim_start_matches("https://").trim_start_matches("http://").to_string();
    body.child(card(p).child(row_(p, &email, "Signed in through Cloudflare Access.", None).child(button("sign-out", "Sign out", false, p).on_press(|s: &mut State| s.sign_out()))))
        .child(text(format!("Signing out forgets this Mac's sign-in to {host}. The next open signs in again in the browser.")).font(SMALL).color(p.quiet).wrap())
}

// ── Scenes ─────────────────────────────────────────────────────────────────────────────────

fn sample(s: &mut State) {
    s.base = Some("https://scotty.example.com".into());
    let source = |id: &str, reference: &str, skills: &[(&str, &str, bool, bool)]| api::Source {
        id: id.into(),
        repo: id.into(),
        path: String::new(),
        reference: (!reference.is_empty()).then(|| reference.into()),
        commit: None,
        skills: skills.iter().map(|(n, d, m, e)| api::Skill { name: (*n).into(), description: (*d).into(), manual: *m, enabled: *e }).collect(),
    };
    s.settings = Some(api::Settings {
        instructions: "Prefer small commits. Run the tests before you finish.\nKeep pull requests under 400 lines.".into(),
        sources: vec![
            source(
                "acme/agent-skills",
                "main",
                &[
                    ("diagnose", "Reproduce a failure, find its cause and fix it.", false, true),
                    ("review", "Read a diff for correctness and say what breaks.", false, true),
                    ("release-notes", "Write the release notes from merged pull requests.", true, false),
                ],
            ),
            source("acme/web", "", &[("storybook", "Run and snapshot the component stories.", false, true)]),
        ],
        claude_style: None,
        email: Some("owner@example.com".into()),
        running: 2,
        max_running: 4,
    });
    s.instructions = TextEdit::new(&s.settings.as_ref().map_or(String::new(), |x| x.instructions.clone()));
    s.accounts = [
        Some(Credential { status: "signed-in".into(), login: None }),
        Some(Credential { status: "expiring".into(), login: None }),
        Some(Credential { status: "set".into(), login: Some("acme-bot".into()) }),
    ];
    s.repos = Some(vec![RepoSize { repo: "acme/web".into(), size: "standard-2".into() }, RepoSize { repo: "acme/api".into(), size: "standard-4".into() }]);
}

fn at(s: &mut State, section: Section) {
    sample(s);
    s.section = section;
}

pub const SCENES: &[(&str, fn(&mut State))] = &[
    ("accounts", |s| at(s, Section::Accounts)),
    ("instructions", |s| {
        at(s, Section::Instructions);
        s.instructions = TextEdit::new("Prefer small commits. Run the tests before you finish.\nKeep pull requests under 400 lines.\nWrite the plan before the code.");
    }),
    ("skills", |s| at(s, Section::Skills)),
    ("repositories", |s| at(s, Section::Repositories)),
    ("connections", |s| at(s, Section::Connections)),
    ("blueprints", |s| at(s, Section::Blueprints)),
    ("running", |s| at(s, Section::Running)),
    ("running-full", |s| {
        at(s, Section::Running);
        if let Some(x) = s.settings.as_mut() {
            x.running = 4;
        }
    }),
    ("signed-in", |s| at(s, Section::SignedIn)),
    ("accounts-light", |s| {
        at(s, Section::Accounts);
        s.appearance = Appearance::Light;
    }),
    ("skills-light", |s| {
        at(s, Section::Skills);
        s.appearance = Appearance::Light;
    }),
    ("error", |s| {
        s.base = Some("https://scotty.example.com".into());
        s.error = "Can't reach Scotty: connection refused".into();
    }),
];
