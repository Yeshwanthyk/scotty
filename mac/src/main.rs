//! Scotty for macOS, drawn with Rune. A desktop window on your Scotty: the sessions in a sidebar
//! (by day, the stopped ones folded away), the open ones as tabs, each with its thread, composer
//! and Changes panel, and Settings in a window of its own. At first launch it asks for your
//! Scotty's address and signs in through its Cloudflare Access (`signin.rs`).
//!
//!   cargo run --release
//!
//! Headless, with no network (`APP_OFFLINE=1`): `--snap out.png --scene list`; Settings with
//! `--window settings --scene accounts`. Scenes are in `view.rs` and `settings.rs`.

mod api;
mod diff;
mod home;
mod live;
mod palette;
mod servers;
mod session;
mod settings;
mod shell;
mod signin;
mod theme;
mod time;
mod view;

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};

use rune::{App, AppHandle, AppSpec, Key, KeyEvent, TextEdit, Tx, WindowOptions, WindowSpec, Waker};
use rune_kit::shell::TabDragState;

use api::{Answer, Conversation, ListFrame, Session, SessionFrame, Status};
use live::{Inbound, Link, Live};
use servers::Server;

/// One open session: what its socket last said, and the draft typed into it.
pub struct Conn {
    pub id: String,
    pub session: Option<Session>,
    pub conversation: Option<Conversation>,
    seq: u64,
    pub link: Link,
    /// The server has no such session.
    pub missing: bool,
    pub draft: TextEdit,
    /// A write in flight; the composer and actions wait.
    pub busy: bool,
    /// `Queued` or `Stopping this turn…`, and the last error.
    pub note: String,
    pub error: String,
    /// The last write's input and the `req` it went with, reused when the same write is retried.
    attempt: Option<(String, String)>,
    /// Every turn shows, not only the last three.
    pub show_all: bool,
    /// The session-actions menu is open, and Delete is asking first.
    pub menu: bool,
    pub confirm_delete: bool,
    pub copied: bool,
    /// The container booted for the current turn: the agent's start shows as a boot step.
    pub booted: bool,
    live: Option<Live<SessionFrame>>,
}

impl Conn {
    fn new(id: &str) -> Conn {
        Conn {
            id: id.to_string(),
            session: None,
            conversation: None,
            seq: 0,
            link: Link::Connecting,
            missing: false,
            draft: TextEdit::new(""),
            busy: false,
            note: String::new(),
            error: String::new(),
            attempt: None,
            show_all: false,
            menu: false,
            confirm_delete: false,
            copied: false,
            booted: false,
            live: None,
        }
    }

    /// Whether a socket follows this session (headless scenes have none).
    pub fn live(&self) -> bool {
        self.live.is_some()
    }

    pub fn turns(&self) -> &[api::Turn] {
        self.conversation.as_ref().map_or(&[], |c| c.turns.as_slice())
    }
}

/// Light, dark, or as macOS is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Appearance {
    System,
    Light,
    Dark,
}

/// The sidebar's chips (`ui/src/data/status.ts` Filter).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Filter {
    All,
    Mine,
    Automations,
    Running,
}

impl Filter {
    pub const ALL: [(Filter, &'static str); 4] = [(Filter::All, "All"), (Filter::Mine, "Mine"), (Filter::Automations, "Automations"), (Filter::Running, "Running")];

    pub fn matches(self, s: &Session) -> bool {
        match self {
            Filter::All => true,
            Filter::Mine => s.mine(),
            Filter::Automations => !s.mine(),
            Filter::Running => s.running(),
        }
    }
}

/// What an HTTP answer was for.
pub enum Ask {
    List,
    /// Is the session still there? (Its socket is down.)
    Check(String),
    /// Steer or interrupt, with the input it carried.
    Write { id: String, action: &'static str, input: String },
    /// Stop, resume or delete.
    Act { id: String, action: &'static str },
    Create,
}

/// The New session sheet.
pub struct Draft {
    pub prompt: TextEdit,
    pub repo: TextEdit,
    pub agent: &'static str,
    pub busy: bool,
    pub error: String,
}

/// Whether this window may talk to its Scotty, which sits behind Cloudflare Access.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Auth {
    /// A token is saved (or none is needed): requests go out.
    Ready,
    /// No good token: the window shows its sign-in screen and sends nothing.
    Needed,
    /// The browser is signing in; the address it opened, once it has.
    Waiting(Option<String>),
    /// The last sign-in failed, and why.
    Failed(String),
}

/// What the sign-in thread reports.
enum SignedIn {
    Opened(String),
    Done(Result<(), String>),
}

struct Signing {
    inbound: Receiver<SignedIn>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for Signing {
    fn drop(&mut self) {
        self.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

pub struct State {
    /// The Scotty this window shows; none while the user types one.
    pub server: Option<Server>,
    pub auth: Auth,
    signing: Option<Signing>,
    pub servers: Vec<Server>,
    pub address: TextEdit,
    pub address_error: Option<String>,
    waker: Option<Waker>,
    wake: Waker,
    wake_slot: Arc<Mutex<Option<Waker>>>,
    http: (Sender<(Ask, Answer)>, Receiver<(Ask, Answer)>),
    /// Every session, as the list and its socket last said.
    pub sessions: Vec<Session>,
    /// The list has loaded once; until then the sidebar shows nothing rather than "No sessions".
    pub listed: bool,
    pub list_error: Option<String>,
    pub list_link: Link,
    list_live: Option<Live<ListFrame>>,
    /// Turns the owner has seen, by session.
    pub seen: HashMap<String, u64>,
    pub conns: Vec<Conn>,
    /// Open sessions, by id, in tab order.
    pub tabs: Vec<String>,
    pub active: usize,
    pub drag: TabDragState,
    pub sidebar: bool,
    pub filter: Filter,
    /// The sidebar's filter menu is open.
    pub filter_menu: bool,
    /// The repository ⌘K picked, shown as a chip.
    pub repo_filter: Option<String>,
    /// The Stopped fold: None follows the default (open when nothing is live).
    pub show_stopped: Option<bool>,
    /// The Changes panel beside the thread.
    pub panel: bool,
    /// What the user opened: a tool's body, a turn's log, a diff file folded shut. By key.
    pub open: HashSet<String>,
    pub finder: Option<palette::Finder>,
    pub new_session: Option<Draft>,
    /// The home page's composer, and its art.
    pub home: home::Home,
    pub art: home::Art,
    pub appearance: Appearance,
    pub dark: std::cell::Cell<bool>,
    pub markdown_dark: rune_kit::MarkdownStyle,
    pub markdown_light: rune_kit::MarkdownStyle,
    pub kit_dark: rune_kit::Kit,
    pub kit_light: rune_kit::Kit,
    /// The Settings window, fed the address when one opens.
    settings: Option<AppHandle<settings::State>>,
    /// A clock for "now", "4m", "Sleeps in": headless scenes pin it.
    pub now: Option<f64>,
}

impl State {
    fn new(settings: Option<AppHandle<settings::State>>) -> State {
        let wake_slot: Arc<Mutex<Option<Waker>>> = Default::default();
        let slot = wake_slot.clone();
        let wake: Waker = Arc::new(move || {
            if let Some(w) = slot.lock().ok().and_then(|w| w.clone()) {
                w();
            }
        });
        State {
            server: None,
            auth: Auth::Ready,
            signing: None,
            servers: Vec::new(),
            address: TextEdit::new(""),
            address_error: None,
            waker: None,
            wake,
            wake_slot,
            http: std::sync::mpsc::channel(),
            sessions: Vec::new(),
            listed: false,
            list_error: None,
            list_link: Link::Connecting,
            list_live: None,
            seen: HashMap::new(),
            conns: Vec::new(),
            tabs: Vec::new(),
            active: 0,
            drag: TabDragState::default(),
            sidebar: true,
            filter: Filter::All,
            filter_menu: false,
            repo_filter: None,
            show_stopped: None,
            panel: false,
            open: HashSet::new(),
            finder: None,
            new_session: None,
            home: home::Home::default(),
            art: home::Art::new(),
            appearance: Appearance::System,
            dark: std::cell::Cell::new(true),
            markdown_dark: theme::markdown(true),
            markdown_light: theme::markdown(false),
            kit_dark: theme::kit(true),
            kit_light: theme::kit(false),
            settings,
            now: None,
        }
    }

    pub fn now(&self) -> f64 {
        self.now.unwrap_or_else(time::now_ms)
    }

    pub fn toggle(&mut self, key: &str) {
        if !self.open.remove(key) {
            self.open.insert(key.to_string());
        }
    }

    fn ask(&self, method: &'static str, path: String, body: Option<String>, tag: Ask) {
        let Some(server) = &self.server else { return };
        if self.waker.is_none() || self.auth != Auth::Ready {
            return;
        }
        let wake = self.wake.clone();
        api::call(server.url.clone(), method, path, body, tag, self.http.0.clone(), move || wake());
    }

    // Sessions and tabs.

    pub fn session(&self, id: &str) -> Option<&Session> {
        self.conns.iter().find(|c| c.id == id).and_then(|c| c.session.as_ref()).or_else(|| self.sessions.iter().find(|s| s.id() == id))
    }

    pub fn status_of(&self, s: &Session) -> Status {
        let current = self.current() == Some(s.id());
        Status::of(s, self.seen.get(s.id()).copied(), current)
    }

    pub fn title_of(&self, id: &str) -> String {
        self.session(id).map_or_else(|| "Session".to_string(), |s| s.display.title.clone())
    }

    pub fn current(&self) -> Option<&str> {
        self.tabs.get(self.active).map(String::as_str)
    }

    pub fn conn(&self) -> Option<&Conn> {
        let id = self.current()?;
        self.conns.iter().find(|c| c.id == id)
    }

    pub fn conn_mut(&mut self) -> Option<&mut Conn> {
        let id = self.tabs.get(self.active)?.clone();
        self.conns.iter_mut().find(|c| c.id == id)
    }

    fn conn_by(&mut self, id: &str) -> Option<&mut Conn> {
        self.conns.iter_mut().find(|c| c.id == id)
    }

    /// Show `id` in a tab: its own if it has one, a new one after the active tab if not.
    pub fn open_session(&mut self, id: &str) {
        self.finder = None;
        self.new_session = None;
        if let Some(i) = self.tabs.iter().position(|t| t == id) {
            self.active = i;
            self.mark_seen();
            return;
        }
        if !self.conns.iter().any(|c| c.id == id) {
            let mut conn = Conn::new(id);
            conn.session = self.sessions.iter().find(|s| s.id() == id).cloned();
            if let (Some(server), Some(_), Auth::Ready) = (&self.server, &self.waker, &self.auth) {
                let wake = self.wake.clone();
                conn.live = Some(live::start(&server.url, &format!("/api/sessions/{}/live", encode(id)), decode_session, move || wake()));
            } else {
                conn.link = Link::Open;
            }
            self.conns.push(conn);
        }
        let at = if self.tabs.is_empty() { 0 } else { (self.active + 1).min(self.tabs.len()) };
        self.tabs.insert(at, id.to_string());
        self.active = at;
        self.mark_seen();
    }

    pub fn close_tab(&mut self, i: usize) {
        if i >= self.tabs.len() {
            return;
        }
        let id = self.tabs.remove(i);
        // Dropping the conn ends its socket.
        self.conns.retain(|c| c.id != id);
        if self.active > i || self.active >= self.tabs.len() {
            self.active = self.active.saturating_sub(1);
        }
        self.mark_seen();
    }

    pub fn move_tab(&mut self, from: usize, to: usize) {
        if from >= self.tabs.len() || to >= self.tabs.len() || from == to {
            return;
        }
        let active = self.tabs.get(self.active).cloned();
        let tab = self.tabs.remove(from);
        self.tabs.insert(to, tab);
        if let Some(active) = active {
            self.active = self.tabs.iter().position(|t| *t == active).unwrap_or(0);
        }
    }

    pub fn select(&mut self, i: usize) {
        if i < self.tabs.len() {
            self.active = i;
            self.mark_seen();
        }
    }

    /// The session on screen has been seen up to its last turn.
    fn mark_seen(&mut self) {
        let Some(id) = self.current().map(str::to_string) else { return };
        let Some(turns) = self.session(&id).map(|s| s.progress.turns) else { return };
        if self.seen.get(&id) == Some(&turns) {
            return;
        }
        self.seen.insert(id.clone(), turns);
        if let Some(server) = &self.server {
            servers::mark_seen(&server.url, &id, turns);
        }
    }

    // Writes.

    /// Steer with what's typed, or interrupt the turn. The same input retried keeps its `req`.
    pub fn write(&mut self, action: &'static str) {
        let Some(conn) = self.conn_mut() else { return };
        let Some(conversation) = &conn.conversation else { return };
        if conn.busy {
            return;
        }
        let turn = conversation.current_turn.clone();
        let text = conn.draft.text.trim().to_string();
        if action == "steer" && text.is_empty() {
            return;
        }
        let input = format!("{action}\u{0}{turn}\u{0}{text}");
        let req = match &conn.attempt {
            Some((same, req)) if *same == input => req.clone(),
            _ => api::uuid(),
        };
        conn.attempt = Some((input.clone(), req.clone()));
        conn.busy = true;
        conn.error.clear();
        let id = conn.id.clone();
        let body = if action == "steer" {
            format!(r#"{{"text":{},"turn":{},"req":{}}}"#, api::json_str(&text), api::json_str(&turn), api::json_str(&req))
        } else {
            format!(r#"{{"turn":{},"req":{}}}"#, api::json_str(&turn), api::json_str(&req))
        };
        self.ask("POST", format!("/api/sessions/{}/{action}", encode(&id)), Some(body), Ask::Write { id, action, input });
    }

    /// Stop, resume or delete the session on screen.
    pub fn act(&mut self, action: &'static str) {
        let Some(conn) = self.conn_mut() else { return };
        conn.menu = false;
        if action == "delete" && !conn.confirm_delete {
            conn.confirm_delete = true;
            return;
        }
        conn.confirm_delete = false;
        conn.busy = true;
        conn.error.clear();
        let id = conn.id.clone();
        let (method, path, body) = match action {
            "delete" => ("DELETE", format!("/api/sessions/{}", encode(&id)), None),
            _ => ("POST", format!("/api/sessions/{}/{action}", encode(&id)), Some("{}".to_string())),
        };
        self.ask(method, path, body, Ask::Act { id, action });
    }

    pub fn copy_id(&mut self) {
        let Some(conn) = self.conn_mut() else { return };
        copy(&conn.id);
        conn.copied = true;
    }

    // New session.

    pub fn start_new(&mut self) {
        self.finder = None;
        if self.server.is_none() {
            return;
        }
        let repo = self.repo_filter.clone().or_else(|| self.conn().and_then(|c| c.session.as_ref()).map(|s| s.display.repository.clone())).unwrap_or_default();
        self.new_session = Some(Draft { prompt: TextEdit::new(""), repo: TextEdit::new(&repo), agent: "codex", busy: false, error: String::new() });
    }

    /// The home composer's Return: the New session sheet, holding what was typed.
    pub fn start_from_home(&mut self) {
        self.start_new();
        let typed = std::mem::take(&mut self.home.prompt);
        if let Some(d) = self.new_session.as_mut() {
            d.prompt = TextEdit::new(typed.text.trim());
        }
    }

    pub fn create(&mut self) {
        let Some(draft) = self.new_session.as_mut() else { return };
        let prompt = draft.prompt.text.trim().to_string();
        let repo = draft.repo.text.trim().to_string();
        if prompt.is_empty() || draft.busy {
            return;
        }
        draft.busy = true;
        draft.error.clear();
        let body = format!(
            r#"{{"title":{},"repo":{},"prompt":{},"agent":{},"provider":"cloudflare"}}"#,
            api::json_str(&title_of(&prompt)),
            api::json_str(&repo),
            api::json_str(&prompt),
            api::json_str(draft.agent)
        );
        self.ask("POST", "/api/sessions".into(), Some(body), Ask::Create);
    }

    // Which Scotty.

    /// Open `server`, closing whatever this window had open.
    pub fn open(&mut self, server: Server) {
        self.close();
        servers::opened(&server);
        self.seen = servers::seen(&server.url);
        if let Some(handle) = &self.settings {
            let base = server.url.clone();
            handle.update(move |s, _| s.connect(base));
        }
        // Signed out shows the sign-in screen straight away, rather than a list that then fails.
        self.auth = match signin::token(&server.url) {
            Err(signin::NoToken::SignIn) => Auth::Needed,
            Ok(_) | Err(signin::NoToken::Bad(_)) => Auth::Ready,
        };
        self.server = Some(server);
        self.connect();
    }

    /// Start the list socket and every open tab's socket, and read the list: at open, and again
    /// once a sign-in lands, so tabs open before it came due keep their place.
    fn connect(&mut self) {
        let (Some(server), Some(_)) = (&self.server, &self.waker) else { return };
        if self.auth != Auth::Ready {
            return;
        }
        let url = server.url.clone();
        let wake = self.wake.clone();
        self.list_live = Some(live::start(&url, "/api/sessions/live", decode_list, move || wake()));
        self.list_link = Link::Connecting;
        for conn in &mut self.conns {
            let wake = self.wake.clone();
            conn.live = Some(live::start(&url, &format!("/api/sessions/{}/live", encode(&conn.id)), decode_session, move || wake()));
            conn.link = Link::Connecting;
        }
        self.ask("GET", "/api/sessions".into(), None, Ask::List);
    }

    /// Scotty refused us, or there is no token: drop the sockets and show the sign-in screen. A
    /// refusal of an older token, with a newer one saved since, connects again with the new one.
    fn need_sign_in(&mut self) {
        if self.auth == Auth::Ready && self.saved_sign_in() {
            self.connect();
        } else if self.auth == Auth::Ready {
            self.auth = Auth::Needed;
            self.list_live = None;
            for conn in &mut self.conns {
                conn.live = None;
            }
        }
    }

    /// Whether the Keychain holds a sign-in for this Scotty that hasn't run out.
    fn saved_sign_in(&self) -> bool {
        self.server.as_ref().is_some_and(|s| signin::token(&s.url).is_ok_and(|t| !t.is_empty()))
    }

    /// The sign-in screen's button: the browser opens on this Scotty's Access page, and a thread
    /// waits for the token to come back. A sign-in already saved (one that finished after Cancel)
    /// goes straight in.
    pub fn sign_in(&mut self) {
        if self.saved_sign_in() {
            self.signing = None;
            self.auth = Auth::Ready;
            self.connect();
            return;
        }
        let (Some(server), Some(_)) = (&self.server, &self.waker) else { return };
        let (tx, rx) = std::sync::mpsc::channel();
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (base, stop, wake) = (server.url.clone(), cancel.clone(), self.wake.clone());
        std::thread::Builder::new()
            .name("scotty-signin".into())
            .spawn(move || {
                let opened = |url: String| {
                    if tx.send(SignedIn::Opened(url)).is_ok() {
                        wake();
                    }
                };
                let done = signin::sign_in(&base, opened, || stop.load(std::sync::atomic::Ordering::Relaxed));
                if tx.send(SignedIn::Done(done)).is_ok() {
                    wake();
                }
            })
            .expect("spawn the sign-in thread");
        self.signing = Some(Signing { inbound: rx, cancel });
        self.auth = Auth::Waiting(None);
    }

    /// Open the sign-in page again, for a browser tab that was closed or lost.
    pub fn reopen_sign_in(&self) {
        if let Auth::Waiting(Some(url)) = &self.auth {
            let _ = std::process::Command::new("open").arg(url).status();
        }
    }

    pub fn cancel_sign_in(&mut self) {
        self.signing = None;
        self.auth = Auth::Needed;
    }

    /// What the sign-in thread said; true when the screen changes.
    fn poll_sign_in(&mut self) -> bool {
        let Some(signing) = &self.signing else { return false };
        let mut changed = false;
        while let Ok(message) = signing.inbound.try_recv() {
            changed = true;
            match message {
                SignedIn::Opened(url) => self.auth = Auth::Waiting(Some(url)),
                SignedIn::Done(Ok(())) => {
                    self.signing = None;
                    self.auth = Auth::Ready;
                    self.connect();
                    return true;
                }
                SignedIn::Done(Err(why)) => {
                    self.signing = None;
                    self.auth = Auth::Failed(why);
                    return true;
                }
            }
        }
        changed
    }

    pub fn open_typed(&mut self) {
        match servers::parse(&self.address.text) {
            Some(server) => {
                self.address.clear();
                self.address_error = None;
                self.open(server);
            }
            None => self.address_error = Some("That isn't an address. It looks like scotty.example.com.".into()),
        }
    }

    /// Back to the address screen.
    pub fn switch(&mut self) {
        self.close();
        self.servers = servers::known();
    }

    /// Forget this Scotty's sign-in, and don't open it at launch.
    pub fn sign_out(&mut self) {
        if let Some(server) = &self.server {
            signin::forget(&server.url);
        }
        servers::forget_last();
        self.switch();
    }

    fn close(&mut self) {
        self.signing = None;
        self.auth = Auth::Ready;
        self.conns.clear();
        self.tabs.clear();
        self.active = 0;
        self.drag = TabDragState::default();
        self.sessions.clear();
        self.listed = false;
        self.list_error = None;
        self.list_link = Link::Connecting;
        self.list_live = None;
        self.seen.clear();
        self.finder = None;
        self.new_session = None;
        self.repo_filter = None;
        self.server = None;
    }

    pub fn open_settings(&mut self, section: Option<settings::Section>) {
        self.finder = None;
        if let Some(handle) = &self.settings {
            if let Some(section) = section {
                handle.update(move |s, _| s.section = section);
            }
            handle.open();
        }
    }

    pub fn set_appearance(&mut self, a: Appearance) {
        self.appearance = a;
        if let Some(handle) = &self.settings {
            handle.update(move |s, _| s.appearance = a);
        }
    }

    // What the sockets and requests brought.

    fn land_list(&mut self, frame: ListFrame) -> bool {
        match frame {
            ListFrame::Session { session } => {
                let id = session.id().to_string();
                match self.sessions.iter_mut().find(|s| s.id() == id) {
                    Some(old) if *old == session => return false,
                    Some(old) => *old = session,
                    None => self.sessions.push(session),
                }
            }
            ListFrame::Removed { id } => {
                let before = self.sessions.len();
                self.sessions.retain(|s| s.id() != id);
                if before == self.sessions.len() {
                    return false;
                }
            }
        }
        self.mark_seen();
        true
    }

    fn answer(&mut self, ask: Ask, answer: Answer) {
        match ask {
            Ask::List => match answer {
                Ok(body) => match serde_json::from_str::<api::List>(&body) {
                    Ok(list) => {
                        self.sessions = list.sessions;
                        self.listed = true;
                        self.list_error = None;
                        self.mark_seen();
                    }
                    Err(e) => self.list_error = Some(format!("Unreadable session list: {e}")),
                },
                Err(f) => self.list_error = Some(f.message),
            },
            Ask::Check(id) => {
                if let (Err(f), Some(conn)) = (answer, self.conn_by(&id)) {
                    if f.status == Some(404) {
                        conn.missing = true;
                        conn.live = None;
                    }
                }
            }
            Ask::Write { id, action, input } => {
                let Some(conn) = self.conn_by(&id) else { return };
                conn.busy = false;
                match answer.map(|b| serde_json::from_str::<WriteReply>(&b).map(|r| r.status)) {
                    Ok(Ok(status)) => {
                        conn.attempt = None;
                        conn.note = if action == "interrupt" { "Stopping this turn…".into() } else if status == "pending" { "Queued".into() } else { String::new() };
                        let sent = input.rsplit('\u{0}').next().unwrap_or("");
                        if action == "steer" && matches!(status.as_str(), "pending" | "delivered") && conn.draft.text.trim() == sent {
                            conn.draft.clear();
                        }
                    }
                    Ok(Err(_)) => conn.error = "Request failed".into(),
                    Err(f) => conn.error = if f.message.is_empty() { "Request failed".into() } else { f.message },
                }
            }
            Ask::Act { id, action } => {
                match answer {
                    Ok(_) if action == "delete" => {
                        self.sessions.retain(|s| s.id() != id);
                        if let Some(i) = self.tabs.iter().position(|t| *t == id) {
                            self.close_tab(i);
                        }
                    }
                    Ok(_) => {
                        if let Some(conn) = self.conn_by(&id) {
                            conn.busy = false;
                        }
                    }
                    Err(f) => {
                        if let Some(conn) = self.conn_by(&id) {
                            conn.busy = false;
                            conn.error = if f.message.is_empty() { format!("Could not {action} the session") } else { f.message };
                        }
                    }
                }
            }
            Ask::Create => match answer.map(|b| serde_json::from_str::<Created>(&b)) {
                Ok(Ok(created)) => {
                    self.new_session = None;
                    self.ask("GET", "/api/sessions".into(), None, Ask::List);
                    self.open_session(&created.id);
                }
                Ok(Err(_)) => {
                    if let Some(d) = self.new_session.as_mut() {
                        d.busy = false;
                        d.error = "Unreadable create response".into();
                    }
                }
                Err(f) => {
                    if let Some(d) = self.new_session.as_mut() {
                        d.busy = false;
                        d.error = if f.message.is_empty() { "Could not create session".into() } else { f.message };
                    }
                }
            },
        }
    }
}

#[derive(serde::Deserialize)]
struct WriteReply {
    status: String,
}

#[derive(serde::Deserialize)]
struct Created {
    id: String,
}

fn decode_list(text: &str) -> Option<ListFrame> {
    serde_json::from_str(text).ok()
}

fn decode_session(text: &str) -> Option<SessionFrame> {
    serde_json::from_str(text).ok()
}

/// A path segment, as `encodeURIComponent` makes it.
pub fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The web's `titleOf`: the prompt's first line, cut to 57 and `…` when over 60.
pub fn title_of(prompt: &str) -> String {
    let line = prompt.trim().lines().next().unwrap_or("");
    if line.chars().count() <= 60 {
        return line.to_string();
    }
    let cut: String = line.chars().take(57).collect();
    format!("{}…", cut.trim_end())
}

/// Put `text` on the clipboard.
pub fn copy(text: &str) {
    use std::io::Write;
    if let Ok(mut child) = std::process::Command::new("pbcopy").stdin(std::process::Stdio::piped()).spawn() {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(text.as_bytes());
        }
        let _ = child.wait();
    }
}

pub fn offline() -> bool {
    std::env::var_os("APP_OFFLINE").is_some()
}

fn setup(state: &mut State, waker: Waker) {
    if let Ok(mut slot) = state.wake_slot.lock() {
        *slot = Some(waker.clone());
    }
    if offline() {
        return;
    }
    state.waker = Some(waker);
    match servers::last() {
        Some(server) => state.open(server),
        None => state.servers = servers::known(),
    }
}

/// Land what the socket and request threads brought. True only when something visible changed.
fn poll(state: &mut State, _clock: f64, _tx: &mut Tx) -> bool {
    let mut changed = state.poll_sign_in();
    let mut relist = false;
    let mut signed_out = false;
    if let Some(live) = &state.list_live {
        let mut frames = Vec::new();
        while let Ok(message) = live.inbound.try_recv() {
            match message {
                Inbound::Link(link) => {
                    // Open again: read the whole list, since frames sent while down are lost.
                    relist |= link == Link::Open;
                    signed_out |= link == Link::SignIn;
                    changed |= state.list_link != link;
                    state.list_link = link;
                }
                Inbound::Frame(frame) => frames.push(frame),
            }
        }
        for frame in frames {
            changed |= state.land_list(frame);
        }
    }
    if relist {
        state.ask("GET", "/api/sessions".into(), None, Ask::List);
    }
    let mut checks = Vec::new();
    for conn in &mut state.conns {
        let Some(live) = &conn.live else { continue };
        while let Ok(message) = live.inbound.try_recv() {
            changed = true;
            match message {
                Inbound::Link(link) => {
                    if matches!(link, Link::Retrying(_)) {
                        checks.push(conn.id.clone());
                    }
                    signed_out |= link == Link::SignIn;
                    conn.link = link;
                }
                Inbound::Frame(frame) => {
                    if frame.seq < conn.seq {
                        continue;
                    }
                    conn.seq = frame.seq;
                    conn.session = Some(frame.session);
                    conn.conversation = Some(frame.conversation);
                    conn.booted = booted(conn);
                    if conn.note == "Stopping this turn…" && !conn.session.as_ref().is_some_and(|s| s.progress.working) {
                        conn.note.clear();
                    }
                }
            }
        }
    }
    for id in checks {
        state.ask("GET", format!("/api/sessions/{}", encode(&id)), None, Ask::Check(id));
    }
    while let Ok((ask, answer)) = state.http.1.try_recv() {
        signed_out |= matches!(&answer, Err(f) if f.status == Some(401));
        state.answer(ask, answer);
        changed = true;
    }
    if signed_out {
        state.need_sign_in();
    }
    if changed {
        state.mark_seen();
    }
    changed
}

/// The web's `booted`: set while the container boots, kept until the first turn's agent answers.
fn booted(conn: &Conn) -> bool {
    let Some(session) = &conn.session else { return false };
    if matches!(session.authority, api::Authority::Transitioning { .. }) {
        return true;
    }
    let waiting = session.progress.working && conn.turns().last().is_some_and(|t| t.state == api::TurnState::Streaming && t.items.is_empty() && t.assistant.is_empty());
    conn.booted && waiting
}

/// The window's shortcuts, as a Mac app's (`palette::SHORTCUTS` lists them).
fn keys(state: &mut State, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if state.server.is_none() || !ev.mods.cmd {
        return false;
    }
    let Key::Command(c) = ev.key else { return false };
    if c != 'k' && state.finder.is_some() {
        return false;
    }
    match c {
        'k' => state.open_palette(),
        't' | 'n' => state.start_new(),
        'w' if state.new_session.is_some() => state.new_session = None,
        'w' if state.tabs.is_empty() => tx.close_window(),
        'w' => state.close_tab(state.active),
        ',' => state.open_settings(None),
        '\\' => state.sidebar = !state.sidebar,
        'd' | '∂' if ev.mods.alt => state.panel = !state.panel,
        'l' | 'L' if ev.mods.shift => state.set_appearance(if state.dark.get() { Appearance::Light } else { Appearance::Dark }),
        '[' | '{' if ev.mods.shift => state.select((state.active + state.tabs.len().max(1) - 1) % state.tabs.len().max(1)),
        ']' | '}' if ev.mods.shift => state.select((state.active + 1) % state.tabs.len().max(1)),
        '9' => state.select(state.tabs.len().saturating_sub(1)),
        '1'..='8' => state.select(c as usize - '1' as usize),
        _ => return false,
    }
    true
}

fn main() {
    // TLS for a deployed Scotty (wss): one crypto provider for the whole process.
    let _ = rustls::crypto::ring::default_provider().install_default();
    rune::prewarm_gpu();
    let mut app = App::new(AppSpec::<State> {
        min_size: Some((720.0, 480.0)),
        families: (theme::SANS, "ui-monospace"),
        scenes: view::SCENES,
        setup: Some(setup),
        poll: Some(poll),
        on_key: Some(keys),
        ..AppSpec::new("Scotty", (1180.0, 820.0), || State::new(None), view::view)
    });
    let main = app.handle();
    let settings_app = App::new(settings::spec()).init(move || settings::State::new(Some(main)));
    let (settings, _) = app.window(WindowSpec::from_app("settings", settings_app).options(WindowOptions { visible: false, ..Default::default() }));
    app.init(move || State::new(Some(settings))).run();
}
