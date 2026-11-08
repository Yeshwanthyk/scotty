//! Scotty's HTTP API as Rust types, field for field with the Effect schemas the web decodes:
//! `ui/src/data/core.ts` (Session, List, write replies, errors) and
//! `ui/src/protocol/session/conversation.ts` (Conversation). Status words and sentences are the
//! web's (`ui/src/data/status.ts`), copied exactly.
//!
//! Requests run on their own thread (`call`), never on the UI thread; each answer comes back over
//! a channel with a tag saying what it was for, and wakes the window.

use std::sync::mpsc::Sender;

use serde::Deserialize;

use crate::time;

// ── Session ──────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Session {
    pub identity: Identity,
    pub authority: Authority,
    pub display: Display,
    pub progress: Progress,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Identity {
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Authority {
    Stable {
        lifecycle: String,
        #[serde(default)]
        stop: Option<Stop>,
        #[serde(default)]
        failure: Option<Failure>,
    },
    Transitioning {
        phase: String,
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Stop {
    pub reason: String,
    #[serde(default, rename = "exitCode")]
    pub exit_code: Option<i64>,
    #[serde(default)]
    pub max: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Failure {
    pub code: String,
    pub recovery: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub title: String,
    pub repository: String,
    pub branch: String,
    pub prompt: String,
    pub agent_kind: String,
    pub size: String,
    pub created_at: String,
    pub active_at: String,
    pub origin: Option<Origin>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Origin {
    Hook { connection: String, delivery: String },
    Api { key: String },
    Automation { automation: String, run: String },
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub working: bool,
    pub turns: u64,
    #[serde(default)]
    pub sleeps_at: Option<String>,
}

#[derive(Deserialize)]
pub struct List {
    pub sessions: Vec<Session>,
}

/// `/api/sessions/live`: one session changed, or one was removed.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ListFrame {
    Session { session: Session },
    Removed { id: String },
}

/// `/api/sessions/{id}/live`: the whole view after a change, ordered by `seq`.
#[derive(Deserialize)]
pub struct SessionFrame {
    pub seq: u64,
    pub session: Session,
    pub conversation: Conversation,
}

impl Session {
    pub fn id(&self) -> &str {
        &self.identity.id
    }
    pub fn lifecycle(&self) -> Option<&str> {
        match &self.authority {
            Authority::Stable { lifecycle, .. } => Some(lifecycle),
            Authority::Transitioning { .. } => None,
        }
    }
    pub fn stop(&self) -> Option<&Stop> {
        match &self.authority {
            Authority::Stable { stop, .. } => stop.as_ref(),
            Authority::Transitioning { .. } => None,
        }
    }
    pub fn failure(&self) -> Option<&Failure> {
        match &self.authority {
            Authority::Stable { failure, .. } => failure.as_ref(),
            Authority::Transitioning { .. } => None,
        }
    }
    /// Stopped: no container. Sending resumes it.
    pub fn dormant(&self) -> bool {
        self.lifecycle() == Some("stopped")
    }
    pub fn running(&self) -> bool {
        matches!(self.authority, Authority::Transitioning { .. }) || self.lifecycle() == Some("running")
    }
    /// `mine`: made here or through the API; the rest came from a hook or an automation.
    pub fn mine(&self) -> bool {
        matches!(self.display.origin, None | Some(Origin::Api { .. }))
    }
    pub fn claude(&self) -> bool {
        self.display.agent_kind == "claude"
    }
}

// ── Status (`ui/src/data/status.ts`) ─────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Starting,
    Working,
    Unseen,
    Idle,
    Asleep,
    Stopped,
    Failed,
}

impl Status {
    /// `statusOf`: `seen` is the turns the owner has seen, if ever; the session on screen is
    /// never unseen.
    pub fn of(s: &Session, seen: Option<u64>, current: bool) -> Status {
        match &s.authority {
            Authority::Transitioning { .. } => Status::Starting,
            Authority::Stable { lifecycle, stop, .. } => {
                if lifecycle == "failed" {
                    Status::Failed
                } else if s.progress.working {
                    Status::Working
                } else if lifecycle == "stopped" {
                    if stop.as_ref().is_some_and(|x| x.reason == "idle") { Status::Asleep } else { Status::Stopped }
                } else if !current && seen.is_some_and(|seen| s.progress.turns > seen) {
                    Status::Unseen
                } else {
                    Status::Idle
                }
            }
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Status::Starting => "Starting",
            Status::Working => "Working",
            Status::Unseen => "New reply",
            Status::Idle => "Ready",
            Status::Asleep => "Asleep",
            Status::Stopped => "Stopped",
            Status::Failed => "Failed",
        }
    }
    /// A status the sidebar says out loud instead of the age.
    pub fn loud(self) -> bool {
        matches!(self, Status::Starting | Status::Failed | Status::Unseen)
    }
}

pub fn stop_label(stop: Option<&Stop>) -> String {
    let Some(stop) = stop else { return "Stopped".into() };
    match stop.reason.as_str() {
        "user" => "Stopped by you".into(),
        "ended" => "Ended by an automation".into(),
        "stalled" => "Stopped — no output".into(),
        "crashed" => match stop.exit_code {
            Some(code) => format!("Crashed (exit {code})"),
            None => "Crashed".into(),
        },
        "exited" => "Container exited".into(),
        "agent" => "Agent exited".into(),
        "deploy" => "Container replaced".into(),
        "cap" => "Too many running".into(),
        "gone" => "Container lost".into(),
        _ => "Stopped".into(),
    }
}

pub fn stop_sentence(stop: Option<&Stop>) -> String {
    let Some(stop) = stop else { return "This session stopped.".into() };
    match stop.reason.as_str() {
        "user" => "You stopped this session.".into(),
        "ended" => "An automation ended this session.".into(),
        "stalled" => "Stopped after 30 minutes with no output from the agent.".into(),
        "crashed" => match stop.exit_code {
            Some(code) => format!("The container crashed (exit {code})."),
            None => "The container crashed.".into(),
        },
        "exited" => "The container exited on its own.".into(),
        "agent" => "The agent exited.".into(),
        "deploy" => "The container was replaced, so work since the last save is gone.".into(),
        "cap" => format!("{} sessions are running; stop one or raise maxRunning.", stop.max.map_or("undefined".to_string(), |m| m.to_string())),
        "gone" => "The container was lost.".into(),
        _ => "This session stopped.".into(),
    }
}

pub fn failure_sentence(failure: Option<&Failure>) -> &'static str {
    match failure.map(|f| f.code.as_str()) {
        Some("container_start" | "container_timeout") => "The container didn't start.",
        Some("workspace" | "workspace_timeout") => "The workspace couldn't be prepared.",
        Some("signin_required") => "The agent needs you to sign in again in Settings.",
        Some("start" | "start_failed" | "dial_timeout" | "redial_timeout") => "The agent didn't start.",
        Some("protocol") => "The agent sent something Scotty couldn't read.",
        _ => "This session failed to start.",
    }
}

/// Codex, Claude or Pi, as the composer's chip names the agent.
pub fn agent_name(kind: &str) -> &'static str {
    match kind {
        "claude" => "Claude",
        "pi" => "Pi",
        _ => "Codex",
    }
}

/// The session line under the title: `owner/name · branch · size · via …`.
pub fn session_line(s: &Session) -> Vec<String> {
    let d = &s.display;
    let mut parts = Vec::new();
    if !d.repository.is_empty() {
        parts.push(d.repository.clone());
    }
    if !d.branch.is_empty() && !d.branch.starts_with("scotty/") {
        parts.push(d.branch.clone());
    }
    parts.push(d.size.clone());
    match &d.origin {
        Some(Origin::Automation { automation, .. }) => parts.push(format!("via {automation}")),
        Some(Origin::Hook { connection, .. }) => parts.push(format!("via webhook {connection}")),
        _ => {}
    }
    parts
}

// ── Conversation (`ui/src/protocol/session/conversation.ts`) ─────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub current_turn: String,
    pub turns: Vec<Turn>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnState {
    Completed,
    Streaming,
    Failed,
    Aborted,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub state: TurnState,
    pub user: String,
    pub assistant: String,
    pub items: Vec<Item>,
    pub diff: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    #[serde(default)]
    pub files: Vec<TurnFile>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TurnFile {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub mime: String,
    pub size: u64,
    #[serde(default)]
    pub caption: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Item {
    Text { id: String, text: String, #[serde(rename = "final")] done: bool },
    Thinking { id: String, text: String },
    Tool(Tool),
    Plan { id: String, steps: Vec<PlanStep> },
    Notice { id: String, text: String, tone: String },
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub category: String,
    pub summary: String,
    pub status: String,
    pub input: String,
    pub output: String,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<f64>,
    pub changes: Vec<Change>,
    #[serde(default)]
    pub parent: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Change {
    pub path: String,
    pub kind: String,
    pub diff: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PlanStep {
    pub step: String,
    pub status: String,
}

impl Item {
    pub fn id(&self) -> &str {
        match self {
            Item::Text { id, .. } | Item::Thinking { id, .. } | Item::Plan { id, .. } | Item::Notice { id, .. } => id,
            Item::Tool(t) => &t.id,
        }
    }
}

// ── Settings (`ui/src/data/settings.ts`) ─────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub instructions: String,
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(default)]
    pub claude_style: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    pub running: u64,
    pub max_running: u64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Source {
    pub id: String,
    pub repo: String,
    #[serde(default)]
    pub path: String,
    /// The branch or tag the source follows; `null` follows the repository's default branch.
    #[serde(rename = "ref", default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub skills: Vec<Skill>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Skill {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub manual: bool,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub status: String,
    #[serde(default)]
    pub login: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct RepoSize {
    pub repo: String,
    pub size: String,
}

#[derive(Deserialize)]
pub struct Repos {
    pub repos: Vec<RepoSize>,
}

// ── Requests ─────────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ErrorBody {
    error: ErrorMessage,
}
#[derive(Deserialize)]
struct ErrorMessage {
    message: String,
}

/// Why a request failed: the HTTP status when the server answered, and the words to show.
#[derive(Clone, Debug, PartialEq)]
pub struct Failed {
    pub status: Option<u16>,
    pub message: String,
}

pub type Answer = Result<String, Failed>;

/// One request, made on its own thread: send it with the saved token and hand back the body or why
/// it failed. No token, or Access refusing it (401, 403, a redirect), answers 401: the window then
/// shows its sign-in screen.
pub fn call<T: Send + 'static>(base: String, method: &'static str, path: String, body: Option<String>, tag: T, out: Sender<(T, Answer)>, wake: impl Fn() + Send + 'static) {
    std::thread::Builder::new()
        .name("scotty-http".into())
        .spawn(move || {
            let key = (method == "POST" && path == "/api/sessions").then(uuid);
            let answer = request(&base, method, &path, body.as_deref(), key.as_deref()).map_err(|e| match e {
                Refused::SignIn => Failed { status: Some(401), message: "Sign in to reach Scotty.".into() },
                Refused::Failed(status, message) => Failed { status, message },
            });
            if out.send((tag, answer)).is_ok() {
                wake();
            }
        })
        .expect("spawn an HTTP thread");
}

enum Refused {
    SignIn,
    Failed(Option<u16>, String),
}

fn request(base: &str, method: &str, path: &str, body: Option<&str>, key: Option<&str>) -> Result<String, Refused> {
    let token = crate::signin::token(base).map_err(|no| match no {
        crate::signin::NoToken::SignIn => Refused::SignIn,
        crate::signin::NoToken::Bad(why) => Refused::Failed(None, why),
    })?;
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(std::time::Duration::from_secs(30)).user_agent(concat!("scotty-mac/", env!("CARGO_PKG_VERSION"))).build();
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let mut req = agent.request(method, &url).set("accept", "application/json");
    if !token.is_empty() {
        req = req.set("cf-access-token", &token).set("Cookie", &format!("CF_Authorization={token}"));
    }
    if let Some(key) = key {
        req = req.set("idempotency-key", key);
    }
    let result = match body {
        Some(b) => req.set("content-type", "application/json").send_string(b),
        None => req.call(),
    };
    let refused = || {
        crate::signin::refused(base, &token);
        Refused::SignIn
    };
    match result {
        Ok(r) if (300..400).contains(&r.status()) => Err(refused()),
        Ok(r) => r.into_string().map_err(|e| Refused::Failed(None, e.to_string())),
        Err(ureq::Error::Status(code, _)) if matches!(code, 401 | 403) => Err(refused()),
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            Err(Refused::Failed(Some(code), serde_json::from_str::<ErrorBody>(&text).map(|e| e.error.message).unwrap_or_else(|_| format!("Request failed ({code})"))))
        }
        Err(e) => Err(Refused::Failed(None, format!("Can't reach Scotty: {}", short(&e.to_string())))),
    }
}

fn short(s: &str) -> &str {
    &s[..s.floor_char_boundary(120)]
}

/// A random v4 UUID, for a write's `req` and a create's `idempotency-key`.
pub fn uuid() -> String {
    use std::io::Read;
    let mut b = [0u8; 16];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
        b = (time::now_ms().to_bits() as u128 ^ u128::from(std::process::id()) << 64).to_le_bytes();
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// A JSON string literal for `text`.
pub fn json_str(text: &str) -> String {
    serde_json::Value::String(text.to_string()).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_skill_source_without_a_ref_still_reads() {
        let body = r#"{"instructions":"","sources":[{"id":"o/r/skills","repo":"o/r","path":"skills","ref":null,"commit":"abc","size":1,"fetched":1,"skills":[]}],"claudeStyle":"default","email":"a@b.c","running":0,"maxRunning":3}"#;
        let settings: Settings = serde_json::from_str(body).unwrap();
        assert_eq!(settings.sources[0].reference, None);
    }
}
