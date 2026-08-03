use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{Context as _, bail};
use serde::{Deserialize, Deserializer, Serialize, de};
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::sync::{mpsc, watch};

const PROTOCOL_VERSION: u8 = 2;
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct ProtocolVersion;

#[derive(Debug, Clone, Copy)]
pub struct ConsoleProtocolVersion;

impl<'de> Deserialize<'de> for ConsoleProtocolVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let version = u8::deserialize(deserializer)?;
        if version == 1 {
            Ok(Self)
        } else {
            Err(de::Error::custom(format!(
                "unsupported console protocol version {version}"
            )))
        }
    }
}

impl<'de> Deserialize<'de> for ProtocolVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let version = u8::deserialize(deserializer)?;
        if version == PROTOCOL_VERSION {
            Ok(Self)
        } else {
            Err(de::Error::custom(format!(
                "unsupported desktop protocol version {version}"
            )))
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopState {
    #[serde(rename = "version")]
    pub _version: ProtocolVersion,
    pub fleet: Vec<FleetSession>,
    pub fleet_error: Option<String>,
    pub selected_session_id: Option<String>,
    pub loading: bool,
    pub selected: Option<SelectedState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetSession {
    pub id: String,
    pub title: String,
    pub status: String,
    pub provider: String,
    pub repo: String,
    pub default_branch: String,
    pub branch: String,
    pub backup_id: Option<String>,
    pub agent_state: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub hard_cap_at: String,
    pub projected_at: String,
    pub age_seconds: Option<f64>,
    pub cap_remaining_seconds: Option<f64>,
    pub failure: Option<SessionFailure>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionFailure {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}

impl FleetSession {
    pub fn usable(&self) -> bool {
        self.status == "warm" && self.provider == "cloudflare"
    }

    pub fn selectable(&self) -> bool {
        self.status != "gone" && self.provider == "cloudflare"
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedState {
    pub metadata: Option<FleetSession>,
    pub draft: String,
    pub draft_generation: u64,
    pub live: Option<LiveState>,
    pub unavailable: Option<UnavailableState>,
    pub error: Option<String>,
    pub command_status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveState {
    pub epoch: String,
    #[serde(rename = "sequence")]
    pub _sequence: u64,
    pub session_revision: u64,
    pub is_streaming: bool,
    pub transcript: Vec<TranscriptItem>,
    pub pending_ui: Vec<PendingUi>,
    pub activity: String,
    #[serde(rename = "sidecarTruncated")]
    pub sidecar_truncated: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ToolStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TranscriptItem {
    User {
        id: String,
        text: String,
    },
    Assistant {
        id: String,
        text: String,
    },
    Thinking {
        id: String,
        text: String,
    },
    Tool {
        id: String,
        name: String,
        summary: String,
        detail: Option<String>,
        status: ToolStatus,
        result: Option<String>,
    },
    Error {
        id: String,
        message: String,
    },
    Notice {
        id: String,
        title: String,
        message: String,
        tone: NoticeTone,
    },
    Fallback {
        id: String,
        text: String,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoticeTone {
    Info,
    Warning,
}

impl TranscriptItem {
    pub fn id(&self) -> &str {
        match self {
            Self::User { id, .. }
            | Self::Assistant { id, .. }
            | Self::Thinking { id, .. }
            | Self::Tool { id, .. }
            | Self::Error { id, .. }
            | Self::Notice { id, .. }
            | Self::Fallback { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "method", rename_all = "lowercase", deny_unknown_fields)]
pub enum PendingUi {
    Select {
        id: String,
        title: String,
        options: Vec<String>,
        #[serde(rename = "timeout")]
        _timeout: Option<f64>,
    },
    Confirm {
        id: String,
        title: String,
        message: String,
        #[serde(rename = "timeout")]
        _timeout: Option<f64>,
    },
    Input {
        id: String,
        title: String,
        placeholder: Option<String>,
        #[serde(rename = "timeout")]
        _timeout: Option<f64>,
    },
    Editor {
        id: String,
        title: String,
        prefill: Option<String>,
    },
}

impl PendingUi {
    pub fn id(&self) -> &str {
        match self {
            Self::Select { id, .. }
            | Self::Confirm { id, .. }
            | Self::Input { id, .. }
            | Self::Editor { id, .. } => id,
        }
    }

    pub fn title(&self) -> &str {
        match self {
            Self::Select { title, .. }
            | Self::Confirm { title, .. }
            | Self::Input { title, .. }
            | Self::Editor { title, .. } => title,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnavailableState {
    #[serde(rename = "version")]
    pub _version: ConsoleProtocolVersion,
    #[serde(rename = "status")]
    pub _status: String,
    pub reason: String,
    #[serde(rename = "retryable")]
    pub _retryable: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Frame {
    Ready {
        #[serde(rename = "version")]
        _version: ProtocolVersion,
    },
    State {
        #[serde(rename = "version")]
        _version: ProtocolVersion,
        state: Box<DesktopState>,
    },
    Error {
        #[serde(rename = "version")]
        _version: ProtocolVersion,
        code: String,
        message: String,
    },
    Operation {
        #[serde(rename = "version")]
        _version: ProtocolVersion,
        #[serde(rename = "requestId")]
        request_id: String,
        action: ManagementAction,
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
        status: OperationStatus,
        message: String,
    },
    Stopped {
        #[serde(rename = "version")]
        _version: ProtocolVersion,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ManagementAction {
    Create,
    Rename,
    Snapshot,
    Resume,
    Vaporize,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OperationStatus {
    Started,
    Succeeded,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionFence {
    pub session_id: String,
    pub expected_epoch: String,
    pub expected_session_revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CommandBody {
    RefreshFleet,
    Select {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Close,
    SetDraft {
        #[serde(rename = "sessionId")]
        session_id: String,
        text: String,
    },
    Submit {
        #[serde(flatten)]
        fence: SelectionFence,
        text: String,
        #[serde(rename = "forceFollowUp", skip_serializing_if = "std::ops::Not::not")]
        force_follow_up: bool,
    },
    Abort {
        #[serde(flatten)]
        fence: SelectionFence,
    },
    Answer {
        #[serde(flatten)]
        fence: SelectionFence,
        #[serde(rename = "requestId")]
        request_id: String,
        answer: Answer,
    },
    CreateSandbox {
        #[serde(rename = "requestId")]
        request_id: String,
        title: String,
        prompt: String,
        repo: String,
        #[serde(rename = "hardCapSeconds")]
        hard_cap_seconds: u64,
    },
    RenameSandbox {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        title: String,
    },
    SnapshotSandbox {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    ResumeSandbox {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    VaporizeSandbox {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Answer {
    Value { value: String },
    Confirmed { confirmed: bool },
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
pub struct DesktopCommand {
    version: u8,
    #[serde(flatten)]
    body: CommandBody,
}

impl DesktopCommand {
    pub fn refresh_fleet() -> Self {
        Self::new(CommandBody::RefreshFleet)
    }

    pub fn select(session_id: String) -> Self {
        Self::new(CommandBody::Select { session_id })
    }

    pub fn close() -> Self {
        Self::new(CommandBody::Close)
    }

    pub fn set_draft(session_id: String, text: String) -> Self {
        Self::new(CommandBody::SetDraft { session_id, text })
    }

    pub fn submit(fence: SelectionFence, text: String, force_follow_up: bool) -> Self {
        Self::new(CommandBody::Submit {
            fence,
            text,
            force_follow_up,
        })
    }

    pub fn abort(fence: SelectionFence) -> Self {
        Self::new(CommandBody::Abort { fence })
    }

    pub fn answer_value(fence: SelectionFence, request_id: String, value: String) -> Self {
        Self::new(CommandBody::Answer {
            fence,
            request_id,
            answer: Answer::Value { value },
        })
    }

    pub fn answer_confirmed(fence: SelectionFence, request_id: String, confirmed: bool) -> Self {
        Self::new(CommandBody::Answer {
            fence,
            request_id,
            answer: Answer::Confirmed { confirmed },
        })
    }

    pub fn answer_cancelled(fence: SelectionFence, request_id: String) -> Self {
        Self::new(CommandBody::Answer {
            fence,
            request_id,
            answer: Answer::Cancelled,
        })
    }

    pub fn create_sandbox(
        request_id: String,
        title: String,
        prompt: String,
        repo: String,
        hard_cap_seconds: u64,
    ) -> Self {
        Self::new(CommandBody::CreateSandbox {
            request_id,
            title,
            prompt,
            repo,
            hard_cap_seconds,
        })
    }

    pub fn rename_sandbox(request_id: String, session_id: String, title: String) -> Self {
        Self::new(CommandBody::RenameSandbox {
            request_id,
            session_id,
            title,
        })
    }

    pub fn snapshot_sandbox(request_id: String, session_id: String) -> Self {
        Self::new(CommandBody::SnapshotSandbox {
            request_id,
            session_id,
        })
    }

    pub fn resume_sandbox(request_id: String, session_id: String) -> Self {
        Self::new(CommandBody::ResumeSandbox {
            request_id,
            session_id,
        })
    }

    pub fn vaporize_sandbox(request_id: String, session_id: String) -> Self {
        Self::new(CommandBody::VaporizeSandbox {
            request_id,
            session_id,
        })
    }

    pub fn shutdown() -> Self {
        Self::new(CommandBody::Shutdown)
    }

    fn new(body: CommandBody) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            body,
        }
    }
}

#[derive(Debug)]
pub enum SidecarEvent {
    Frame(Frame),
    Disconnected(String),
}

pub struct SidecarConnection {
    pub commands: mpsc::Sender<DesktopCommand>,
    pub events: mpsc::Receiver<SidecarEvent>,
    pub shutdown: watch::Sender<bool>,
}

impl SidecarConnection {
    pub async fn spawn() -> anyhow::Result<Self> {
        let executable = resolve_sidecar_path()?;
        let mut command = tokio::process::Command::new(&executable);
        command.env_clear();
        for key in [
            "HOME",
            "XDG_CONFIG_HOME",
            "TMPDIR",
            "PATH",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "LANG",
            "LC_ALL",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        if let Some(parent) = executable.parent() {
            command.current_dir(parent);
        }
        if let Some(config) = std::env::var_os("SCOTTY_DESKTOP_CONFIG") {
            command.arg("--config").arg(config);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("starting desktop sidecar at {}", executable.display()))?;
        let mut stdin = child
            .stdin
            .take()
            .context("desktop sidecar stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("desktop sidecar stdout unavailable")?;
        let (command_tx, mut command_rx) = mpsc::channel::<DesktopCommand>(256);
        let (event_tx, event_rx) = mpsc::channel::<SidecarEvent>(8);
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

        let writer_events = event_tx.clone();
        let writer_shutdown = shutdown_tx.clone();
        tokio::spawn(async move {
            while let Some(command) = command_rx.recv().await {
                let shutdown = matches!(command.body, CommandBody::Shutdown);
                let encoded = match serde_json::to_vec(&command) {
                    Ok(encoded) => encoded,
                    Err(error) => {
                        let _ = writer_events
                            .send(SidecarEvent::Disconnected(error.to_string()))
                            .await;
                        let _ = writer_shutdown.send(true);
                        return;
                    }
                };
                if stdin.write_all(&encoded).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    let _ = writer_events
                        .send(SidecarEvent::Disconnected(
                            "Desktop sidecar command pipe closed".into(),
                        ))
                        .await;
                    let _ = writer_shutdown.send(true);
                    return;
                }
                if shutdown {
                    break;
                }
            }
            let _ = writer_shutdown.send(true);
        });

        let reader_events = event_tx.clone();
        let reader_shutdown = shutdown_tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buffer = Vec::new();
            loop {
                buffer.clear();
                match (&mut reader)
                    .take((MAX_FRAME_BYTES + 1) as u64)
                    .read_until(b'\n', &mut buffer)
                    .await
                {
                    Ok(0) => {
                        let _ = reader_events
                            .send(SidecarEvent::Disconnected(
                                "Desktop sidecar output closed".into(),
                            ))
                            .await;
                        let _ = reader_shutdown.send(true);
                        return;
                    }
                    Ok(_) if buffer.len() > MAX_FRAME_BYTES => {
                        let _ = reader_events
                            .send(SidecarEvent::Disconnected(
                                "Desktop sidecar frame exceeded its size limit".into(),
                            ))
                            .await;
                        let _ = reader_shutdown.send(true);
                        return;
                    }
                    Ok(_) => match serde_json::from_slice::<Frame>(&buffer) {
                        Ok(frame) => {
                            if reader_events
                                .send(SidecarEvent::Frame(frame))
                                .await
                                .is_err()
                            {
                                let _ = reader_shutdown.send(true);
                                return;
                            }
                        }
                        Err(_) => {
                            let _ = reader_events
                                .send(SidecarEvent::Disconnected(
                                    "Desktop sidecar emitted an invalid frame".into(),
                                ))
                                .await;
                            let _ = reader_shutdown.send(true);
                            return;
                        }
                    },
                    Err(_) => {
                        let _ = reader_events
                            .send(SidecarEvent::Disconnected(
                                "Desktop sidecar output failed".into(),
                            ))
                            .await;
                        let _ = reader_shutdown.send(true);
                        return;
                    }
                }
            }
        });

        tokio::spawn(async move {
            let _ = shutdown_rx.changed().await;
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let status = match child.try_wait() {
                Ok(Some(status)) => Ok(status),
                Ok(None) => {
                    let _ = child.kill().await;
                    child.wait().await
                }
                Err(error) => Err(error),
            };
            match status {
                Ok(status) if status.success() => {}
                Ok(status) => {
                    let _ = event_tx
                        .send(SidecarEvent::Disconnected(format!(
                            "Desktop sidecar exited with {status}"
                        )))
                        .await;
                }
                Err(_) => {
                    let _ = event_tx
                        .send(SidecarEvent::Disconnected(
                            "Desktop sidecar process failed".into(),
                        ))
                        .await;
                }
            }
        });

        Ok(Self {
            commands: command_tx,
            events: event_rx,
            shutdown: shutdown_tx,
        })
    }
}

fn resolve_sidecar_path() -> anyhow::Result<PathBuf> {
    if let Some(path) = std::env::var_os("SCOTTY_DESKTOP_SIDECAR") {
        let path = PathBuf::from(path);
        return if path.is_absolute() {
            Ok(path)
        } else {
            Ok(std::env::current_dir()
                .context("resolving desktop working directory")?
                .join(path))
        };
    }
    let current = std::env::current_exe().context("resolving desktop executable")?;
    let parent = current
        .parent()
        .context("desktop executable has no parent")?;
    let candidates = [
        parent.join("scotty-console-sidecar"),
        parent.join("../Resources/scotty-console-sidecar"),
        std::env::current_dir()
            .context("resolving desktop working directory")?
            .join("dist/scotty-console-sidecar"),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    bail!(
        "desktop sidecar not found; set SCOTTY_DESKTOP_SIDECAR or build dist/scotty-console-sidecar"
    )
}

#[cfg(test)]
mod tests {
    use super::{CommandBody, DesktopCommand, Frame, PendingUi, SelectionFence};

    fn fence() -> SelectionFence {
        SelectionFence {
            session_id: "a0b1c2d3e4f5".into(),
            expected_epoch: "epoch-1".into(),
            expected_session_revision: 7,
        }
    }

    #[test]
    fn serializes_the_versioned_sidecar_contract() {
        assert_eq!(
            serde_json::to_value(DesktopCommand::select("a0b1c2d3e4f5".into())).unwrap(),
            serde_json::json!({
                "version": 2,
                "type": "select",
                "sessionId": "a0b1c2d3e4f5"
            })
        );
        assert_eq!(
            serde_json::to_value(DesktopCommand::answer_confirmed(
                fence(),
                "request-1".into(),
                true,
            ))
            .unwrap(),
            serde_json::json!({
                "version": 2,
                "type": "answer",
                "sessionId": "a0b1c2d3e4f5",
                "expectedEpoch": "epoch-1",
                "expectedSessionRevision": 7,
                "requestId": "request-1",
                "answer": { "type": "confirmed", "confirmed": true }
            })
        );
        assert_eq!(
            serde_json::to_value(DesktopCommand::create_sandbox(
                "request-create-0001".into(),
                "Review branch".into(),
                "Review this branch".into(),
                "owner/repo".into(),
                14_400,
            ))
            .unwrap(),
            serde_json::json!({
                "version": 2,
                "type": "create_sandbox",
                "requestId": "request-create-0001",
                "title": "Review branch",
                "prompt": "Review this branch",
                "repo": "owner/repo",
                "hardCapSeconds": 14_400
            })
        );
        assert!(matches!(
            DesktopCommand::shutdown().body,
            CommandBody::Shutdown
        ));
    }

    #[test]
    fn rejects_an_unknown_protocol_version_or_field() {
        assert!(
            serde_json::from_value::<Frame>(serde_json::json!({
                "version": 1,
                "type": "ready"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<Frame>(serde_json::json!({
                "version": 2,
                "type": "ready",
                "credential": "no"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<Frame>(serde_json::json!({
                "version": 1,
                "type": "operation",
                "requestId": "request-resume-0001",
                "action": "resume",
                "sessionId": "a0b1c2d3e4f5",
                "status": "succeeded",
                "message": "Resume completed"
            }))
            .is_err()
        );
    }

    #[test]
    fn decodes_a_selected_live_session_projection() {
        let mut wire = serde_json::json!({
            "version": 2,
            "type": "state",
            "state": {
                "version": 2,
                "fleet": [{
                    "id": "a0b1c2d3e4f5",
                    "title": "Desktop",
                    "status": "warm",
                    "provider": "cloudflare",
                    "repo": "owner/scotty",
                    "defaultBranch": "main",
                    "branch": "feature",
                    "agentState": "waiting",
                    "createdAt": "then",
                    "updatedAt": "now",
                    "hardCapAt": "later",
                    "projectedAt": "now"
                }],
                "fleetError": null,
                "selectedSessionId": "a0b1c2d3e4f5",
                "loading": false,
                "selected": {
                    "draft": "answer",
                    "draftGeneration": 4,
                    "live": {
                        "epoch": "epoch-1",
                        "sequence": 9,
                        "sessionRevision": 7,
                        "isStreaming": true,
                        "transcript": [{
                            "kind": "assistant",
                            "id": "message-1",
                            "text": "Ready"
                        }],
                        "pendingUi": [{
                            "id": "request-1",
                            "method": "confirm",
                            "title": "Continue?",
                            "message": "Run proof"
                        }],
                        "activity": "waiting",
                        "sidecarTruncated": false
                    },
                    "unavailable": null,
                    "error": null,
                    "commandStatus": null
                }
            }
        });
        let frame = serde_json::from_value::<Frame>(wire.clone()).unwrap();
        wire["state"]["selected"]["live"]["credential"] = serde_json::json!("no");
        assert!(serde_json::from_value::<Frame>(wire).is_err());

        let Frame::State { state, .. } = frame else {
            panic!("expected state frame")
        };
        let selected = state.selected.unwrap();
        assert_eq!(state.fleet[0].title, "Desktop");
        assert_eq!(selected.live.as_ref().unwrap().transcript.len(), 1);
        assert!(matches!(
            selected.live.unwrap().pending_ui[0],
            PendingUi::Confirm { .. }
        ));
    }

    #[test]
    fn accepts_console_v1_unavailable_state_inside_desktop_v2() {
        let frame = serde_json::from_value::<Frame>(serde_json::json!({
            "version": 2,
            "type": "state",
            "state": {
                "version": 2,
                "fleet": [],
                "fleetError": null,
                "selectedSessionId": "a0b1c2d3e4f5",
                "loading": false,
                "selected": {
                    "metadata": null,
                    "draft": "",
                    "draftGeneration": 0,
                    "live": null,
                    "unavailable": {
                        "version": 1,
                        "status": "unavailable",
                        "reason": "Session is sleeping",
                        "retryable": true
                    },
                    "error": null,
                    "commandStatus": null
                }
            }
        }))
        .unwrap();

        let Frame::State { state, .. } = frame else {
            panic!("expected state frame")
        };
        assert_eq!(
            state
                .selected
                .and_then(|selected| selected.unavailable)
                .map(|unavailable| unavailable.reason),
            Some("Session is sleeping".into())
        );
    }

    #[test]
    fn accepts_unknown_operation_outcomes() {
        let frame = serde_json::from_value::<Frame>(serde_json::json!({
            "version": 2,
            "type": "operation",
            "requestId": "request-snapshot-0001",
            "action": "snapshot",
            "sessionId": "a0b1c2d3e4f5",
            "status": "unknown",
            "message": "Outcome unknown; inspect the refreshed fleet"
        }))
        .unwrap();

        assert!(matches!(
            frame,
            Frame::Operation {
                status: super::OperationStatus::Unknown,
                ..
            }
        ));
    }
}
