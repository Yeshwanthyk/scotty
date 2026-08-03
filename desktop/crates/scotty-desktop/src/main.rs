mod app_menus;
mod markdown;
mod sidecar;
mod theme;

use std::borrow::Cow;
use std::collections::HashSet;

use gpui::{
    App, AppContext as _, Bounds, Context, FocusHandle, Focusable, FollowMode, FontStyle,
    FontWeight, HighlightStyle, IntoElement, KeyDownEvent, ListAlignment, ListState, Render, Role,
    SharedString, StyledText, Task, TitlebarOptions, Window, WindowBounds, WindowOptions, div,
    list, prelude::*, px, size,
};
use gpui_tokio::Tokio;
use markdown::{MarkdownBlock, MarkdownBlockKind, MarkdownStyle, parse_markdown};
use sidecar::{
    DesktopCommand, DesktopState, Frame, ManagementAction, NoticeTone, OperationStatus, PendingUi,
    SelectionFence, SidecarConnection, SidecarEvent, ToolStatus, TranscriptItem,
};
use theme::Theme;

static FONT_GEIST: &[u8] = include_bytes!("../assets/fonts/Geist.ttf");
static FONT_GEIST_MONO: &[u8] = include_bytes!("../assets/fonts/GeistMono.ttf");
static FONT_GEIST_MEDIUM: &[u8] = include_bytes!("../assets/fonts/Geist-Medium.ttf");
static FONT_GEIST_SEMIBOLD: &[u8] = include_bytes!("../assets/fonts/Geist-SemiBold.ttf");
static FONT_GEIST_BOLD: &[u8] = include_bytes!("../assets/fonts/Geist-Bold.ttf");

const MAX_DRAFT_BYTES: usize = 16 * 1024;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .init();

    let app = gpui_platform::application();
    app.on_reopen(|cx| {
        if cx.windows().is_empty() {
            open_main_window(cx);
        }
    });
    app.run(|cx: &mut App| {
        gpui_tokio::init(cx);
        register_fonts(cx);
        app_menus::init(cx);
        cx.set_menus(app_menus::app_menus());
        cx.set_global(Theme::dark());
        open_main_window(cx);
    });
}

fn open_main_window(cx: &mut App) {
    let bounds = Bounds::centered(None, size(px(1240.0), px(820.0)), cx);
    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(900.0), px(600.0))),
            titlebar: Some(TitlebarOptions {
                title: None,
                appears_transparent: true,
                traffic_light_position: Some(gpui::point(px(14.0), px(14.0))),
            }),
            app_owns_titlebar_drag: true,
            window_background: if cfg!(target_os = "macos") {
                gpui::WindowBackgroundAppearance::Blurred
            } else {
                gpui::WindowBackgroundAppearance::Opaque
            },
            app_id: Some("scotty-desktop".into()),
            ..Default::default()
        },
        |window, cx| {
            let view = cx.new(DesktopView::new);
            window.focus(&view.read(cx).focus_handle(cx), cx);
            view
        },
    )
    .expect("failed to open Scotty desktop window");
    cx.activate(true);
}

fn register_fonts(cx: &App) {
    if let Err(error) = cx.text_system().add_fonts(vec![
        Cow::Borrowed(FONT_GEIST),
        Cow::Borrowed(FONT_GEIST_MONO),
        Cow::Borrowed(FONT_GEIST_MEDIUM),
        Cow::Borrowed(FONT_GEIST_SEMIBOLD),
        Cow::Borrowed(FONT_GEIST_BOLD),
    ]) {
        tracing::warn!(%error, "failed to register embedded fonts");
    }
}

enum ConnectionStatus {
    Connecting,
    Ready,
    Failed(String),
    Stopped,
}

#[derive(Default)]
struct ToolExpansions {
    keys: HashSet<String>,
}

impl ToolExpansions {
    fn is_expanded(&self, session_id: &str, tool_id: &str) -> bool {
        self.keys.contains(&tool_key(session_id, tool_id))
    }

    fn toggle(&mut self, session_id: &str, tool_id: &str) {
        let key = tool_key(session_id, tool_id);
        if !self.keys.remove(&key) {
            if self.keys.len() >= 512 {
                self.keys.clear();
            }
            self.keys.insert(key);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CreateField {
    Title,
    Repo,
    Prompt,
    HardCap,
}

impl CreateField {
    fn next(self) -> Self {
        match self {
            Self::Title => Self::Repo,
            Self::Repo => Self::Prompt,
            Self::Prompt => Self::HardCap,
            Self::HardCap => Self::Title,
        }
    }
}

#[derive(Clone)]
enum ManagementPanel {
    Create {
        field: CreateField,
        title: String,
        repo: String,
        prompt: String,
        hard_cap: String,
    },
    Rename {
        session_id: String,
        title: String,
    },
    Vaporize {
        session_id: String,
        title: String,
        confirmation: String,
    },
}

impl ManagementPanel {
    fn action(&self) -> ManagementAction {
        match self {
            Self::Create { .. } => ManagementAction::Create,
            Self::Rename { .. } => ManagementAction::Rename,
            Self::Vaporize { .. } => ManagementAction::Vaporize,
        }
    }
}

struct OperationNotice {
    request_id: String,
    action: ManagementAction,
    session_id: Option<String>,
    status: OperationStatus,
    message: String,
}

struct DesktopView {
    focus: FocusHandle,
    connection: ConnectionStatus,
    state: Option<DesktopState>,
    commands: Option<tokio::sync::mpsc::Sender<DesktopCommand>>,
    shutdown: Option<tokio::sync::watch::Sender<bool>>,
    draft: String,
    draft_generation: u64,
    transcript_list: ListState,
    transcript_ids: Vec<String>,
    unseen_transcript: usize,
    tool_expansions: ToolExpansions,
    management_panel: Option<ManagementPanel>,
    operation: Option<OperationNotice>,
    command_error: Option<String>,
    _events: Task<()>,
}

impl DesktopView {
    fn new(cx: &mut Context<Self>) -> Self {
        let transcript_list = ListState::new(0, ListAlignment::Bottom, px(600.0));
        transcript_list.set_follow_mode(FollowMode::Tail);
        let boot = Tokio::spawn(cx, SidecarConnection::spawn());
        let events = cx.spawn(async move |this, cx| {
            let connection = match boot.await {
                Ok(Ok(connection)) => connection,
                Ok(Err(error)) => {
                    this.update(cx, |view, cx| {
                        view.connection = ConnectionStatus::Failed(error.to_string());
                        cx.notify();
                    })
                    .ok();
                    return;
                }
                Err(error) => {
                    this.update(cx, |view, cx| {
                        view.connection = ConnectionStatus::Failed(error.to_string());
                        cx.notify();
                    })
                    .ok();
                    return;
                }
            };
            let commands = connection.commands;
            let shutdown = connection.shutdown;
            let mut incoming = connection.events;
            if this
                .update(cx, |view, cx| {
                    view.commands = Some(commands);
                    view.shutdown = Some(shutdown);
                    cx.notify();
                })
                .is_err()
            {
                return;
            }
            while let Some(event) = incoming.recv().await {
                if this
                    .update(cx, |view, cx| {
                        view.apply_event(event);
                        cx.notify();
                    })
                    .is_err()
                {
                    return;
                }
            }
        });
        Self {
            focus: cx.focus_handle(),
            connection: ConnectionStatus::Connecting,
            state: None,
            commands: None,
            shutdown: None,
            draft: String::new(),
            draft_generation: 0,
            transcript_list,
            transcript_ids: Vec::new(),
            unseen_transcript: 0,
            tool_expansions: ToolExpansions::default(),
            management_panel: None,
            operation: None,
            command_error: None,
            _events: events,
        }
    }

    fn apply_event(&mut self, event: SidecarEvent) {
        match event {
            SidecarEvent::Frame(Frame::Ready { .. }) => self.connection = ConnectionStatus::Ready,
            SidecarEvent::Frame(Frame::State { state, .. }) => {
                let selection_changed = self
                    .state
                    .as_ref()
                    .and_then(|current| current.selected_session_id.as_deref())
                    != state.selected_session_id.as_deref();
                if let Some(selected) = state.selected.as_ref() {
                    if should_apply_draft(
                        selection_changed,
                        selected.draft_generation,
                        self.draft_generation,
                    ) {
                        self.draft = selected.draft.clone();
                        self.draft_generation = selected.draft_generation;
                    }
                } else if selection_changed {
                    self.draft.clear();
                    self.draft_generation = 0;
                }
                self.sync_transcript_list(&state, selection_changed);
                self.state = Some(*state);
                self.connection = ConnectionStatus::Ready;
            }
            SidecarEvent::Frame(Frame::Error { code, message, .. }) => {
                let message = format!("{code}: {message}");
                if matches!(self.connection, ConnectionStatus::Connecting) {
                    self.connection = ConnectionStatus::Failed(message);
                } else {
                    self.command_error = Some(message);
                }
            }
            SidecarEvent::Frame(Frame::Operation {
                request_id,
                action,
                session_id,
                status,
                message,
                ..
            }) => {
                if status == OperationStatus::Succeeded
                    && self
                        .management_panel
                        .as_ref()
                        .is_some_and(|panel| panel.action() == action)
                {
                    self.management_panel = None;
                }
                self.operation = Some(OperationNotice {
                    request_id,
                    action,
                    session_id,
                    status,
                    message,
                });
            }
            SidecarEvent::Frame(Frame::Stopped { .. }) => {
                if !matches!(self.connection, ConnectionStatus::Failed(_)) {
                    self.connection = ConnectionStatus::Stopped;
                }
            }
            SidecarEvent::Disconnected(message) => {
                if !matches!(self.connection, ConnectionStatus::Failed(_)) {
                    self.connection = ConnectionStatus::Failed(message);
                }
            }
        }
    }

    fn sync_transcript_list(&mut self, state: &DesktopState, selection_changed: bool) {
        let was_at_end = self.transcript_list.is_scrolled_to_end().unwrap_or(true);
        let previous_len = self.transcript_ids.len();
        let next_ids = state
            .selected
            .as_ref()
            .and_then(|selected| selected.live.as_ref())
            .map(|live| {
                live.transcript
                    .iter()
                    .map(|item| item.id().to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if selection_changed {
            self.transcript_list.reset(next_ids.len());
            self.transcript_list.set_follow_mode(FollowMode::Tail);
            self.unseen_transcript = 0;
        } else if next_ids == self.transcript_ids {
            let start = next_ids.len().saturating_sub(8);
            if start < next_ids.len() {
                self.transcript_list.remeasure_items(start..next_ids.len());
            }
        } else {
            let prefix = self
                .transcript_ids
                .iter()
                .zip(&next_ids)
                .take_while(|(current, next)| current == next)
                .count();
            self.transcript_list
                .splice(prefix..self.transcript_ids.len(), next_ids.len() - prefix);
            if was_at_end {
                self.unseen_transcript = 0;
            } else {
                self.unseen_transcript = self
                    .unseen_transcript
                    .saturating_add(next_ids.len().saturating_sub(previous_len));
            }
        }
        self.transcript_ids = next_ids;
    }

    fn send(&mut self, command: DesktopCommand) {
        self.command_error = None;
        let Some(commands) = &self.commands else {
            return;
        };
        if commands.try_send(command).is_err() {
            self.connection = ConnectionStatus::Failed("Desktop command queue is full".into());
        }
    }

    fn sync_draft(&mut self) {
        if let Some(session_id) = self
            .state
            .as_ref()
            .and_then(|state| state.selected_session_id.clone())
        {
            self.draft_generation = self.draft_generation.saturating_add(1);
            self.send(DesktopCommand::set_draft(session_id, self.draft.clone()));
        }
    }

    fn selection_fence(&self) -> Option<SelectionFence> {
        let state = self.state.as_ref()?;
        make_selection_fence(
            state.selected_session_id.as_deref(),
            state.selected.as_ref(),
        )
    }

    fn submit(&mut self, force_follow_up: bool) {
        if self.draft.trim().is_empty() {
            return;
        }
        let Some(fence) = self.selection_fence() else {
            return;
        };
        let pending = self
            .state
            .as_ref()
            .and_then(|state| state.selected.as_ref())
            .and_then(|selected| selected.live.as_ref())
            .and_then(|live| live.pending_ui.first())
            .cloned();
        if let Some(pending) = pending {
            match pending {
                PendingUi::Input { id, .. } | PendingUi::Editor { id, .. } => {
                    self.send(DesktopCommand::answer_value(fence, id, self.draft.clone()));
                    return;
                }
                PendingUi::Select { .. } | PendingUi::Confirm { .. } => return,
            }
        }
        self.send(DesktopCommand::submit(
            fence,
            self.draft.clone(),
            force_follow_up,
        ));
    }

    fn next_request_id(&self, action: &str) -> String {
        format!("desktop-{action}-{}", uuid::Uuid::new_v4())
    }

    fn open_create(&mut self) {
        let repo = self
            .state
            .as_ref()
            .and_then(|state| {
                let selected_id = state.selected_session_id.as_deref()?;
                state.fleet.iter().find(|session| session.id == selected_id)
            })
            .map(|session| session.repo.clone())
            .unwrap_or_default();
        self.management_panel = Some(ManagementPanel::Create {
            field: CreateField::Title,
            title: String::new(),
            repo,
            prompt: String::new(),
            hard_cap: "4h".into(),
        });
    }

    fn open_rename(&mut self, session_id: String, title: String) {
        self.management_panel = Some(ManagementPanel::Rename { session_id, title });
    }

    fn open_vaporize(&mut self, session_id: String, title: String) {
        self.management_panel = Some(ManagementPanel::Vaporize {
            session_id,
            title,
            confirmation: String::new(),
        });
    }

    fn management_failure(&mut self, action: ManagementAction, message: impl Into<String>) {
        self.operation = Some(OperationNotice {
            request_id: "local-validation".into(),
            action,
            session_id: None,
            status: OperationStatus::Failed,
            message: message.into(),
        });
    }

    fn submit_management(&mut self) {
        if self.operation_running() {
            return;
        }
        let Some(panel) = self.management_panel.clone() else {
            return;
        };
        match panel {
            ManagementPanel::Create {
                field: _,
                title,
                repo,
                prompt,
                hard_cap,
            } => {
                let title = title.trim().to_string();
                let repo = repo.trim().to_string();
                let prompt = prompt.trim().to_string();
                let validation = if title.is_empty() {
                    Err("Title is required")
                } else if prompt.is_empty() {
                    Err("Initial prompt is required")
                } else if !valid_repo(&repo) {
                    Err("Repository must be OWNER/NAME")
                } else {
                    Ok(())
                };
                let hard_cap_seconds = match validation.and_then(|_| parse_hard_cap(&hard_cap)) {
                    Ok(seconds) => seconds,
                    Err(message) => {
                        self.management_failure(ManagementAction::Create, message);
                        return;
                    }
                };
                let request_id = self.next_request_id("create");
                self.send(DesktopCommand::create_sandbox(
                    request_id,
                    title,
                    prompt,
                    repo,
                    hard_cap_seconds,
                ));
            }
            ManagementPanel::Rename { session_id, title } => {
                let title = title.trim().to_string();
                if title.is_empty() {
                    self.management_failure(ManagementAction::Rename, "Title is required");
                    return;
                }
                let request_id = self.next_request_id("rename");
                self.send(DesktopCommand::rename_sandbox(
                    request_id, session_id, title,
                ));
            }
            ManagementPanel::Vaporize {
                session_id,
                title: _,
                confirmation,
            } => {
                if confirmation.trim() != session_id {
                    self.management_failure(
                        ManagementAction::Vaporize,
                        "Type the sandbox ID exactly to confirm vaporization",
                    );
                    return;
                }
                let request_id = self.next_request_id("vaporize");
                self.send(DesktopCommand::vaporize_sandbox(request_id, session_id));
            }
        }
    }

    fn operation_running(&self) -> bool {
        self.operation
            .as_ref()
            .is_some_and(|operation| operation.status == OperationStatus::Started)
    }

    fn on_management_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        if self.management_panel.is_none() {
            return false;
        }
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if key == "escape" {
            self.management_panel = None;
        } else if modifiers.platform && key == "a" {
            match &mut self.management_panel {
                Some(ManagementPanel::Create {
                    field,
                    title,
                    repo,
                    prompt,
                    hard_cap,
                }) => match field {
                    CreateField::Title => title.clear(),
                    CreateField::Repo => repo.clear(),
                    CreateField::Prompt => prompt.clear(),
                    CreateField::HardCap => hard_cap.clear(),
                },
                Some(ManagementPanel::Rename { title, .. }) => title.clear(),
                Some(ManagementPanel::Vaporize { confirmation, .. }) => confirmation.clear(),
                None => {}
            }
        } else if key == "tab" {
            if let Some(ManagementPanel::Create { field, .. }) = &mut self.management_panel {
                *field = field.next();
            }
        } else if key == "enter" {
            let should_submit = match &mut self.management_panel {
                Some(ManagementPanel::Create { field, prompt, .. })
                    if *field == CreateField::Prompt && !modifiers.platform =>
                {
                    prompt.push('\n');
                    false
                }
                Some(ManagementPanel::Create { field, .. }) if !modifiers.platform => {
                    *field = field.next();
                    false
                }
                _ => true,
            };
            if should_submit {
                self.submit_management();
            }
        } else if key == "backspace" {
            match &mut self.management_panel {
                Some(ManagementPanel::Create {
                    field,
                    title,
                    repo,
                    prompt,
                    hard_cap,
                }) => match field {
                    CreateField::Title => {
                        title.pop();
                    }
                    CreateField::Repo => {
                        repo.pop();
                    }
                    CreateField::Prompt => {
                        prompt.pop();
                    }
                    CreateField::HardCap => {
                        hard_cap.pop();
                    }
                },
                Some(ManagementPanel::Rename { title, .. }) => {
                    title.pop();
                }
                Some(ManagementPanel::Vaporize { confirmation, .. }) => {
                    confirmation.pop();
                }
                None => {}
            }
        } else {
            let inserted = if modifiers.platform && key == "v" {
                cx.read_from_clipboard().and_then(|item| item.text())
            } else if !modifiers.platform && !modifiers.control {
                event.keystroke.key_char.clone()
            } else {
                None
            };
            let Some(inserted) = inserted else {
                return true;
            };
            match &mut self.management_panel {
                Some(ManagementPanel::Create {
                    field,
                    title,
                    repo,
                    prompt,
                    hard_cap,
                }) => {
                    let (target, limit) = match field {
                        CreateField::Title => (title, 120),
                        CreateField::Repo => (repo, 200),
                        CreateField::Prompt => (prompt, MAX_DRAFT_BYTES),
                        CreateField::HardCap => (hard_cap, 16),
                    };
                    append_bounded(target, &inserted, limit);
                }
                Some(ManagementPanel::Rename { title, .. }) => {
                    append_bounded(title, &inserted, 120);
                }
                Some(ManagementPanel::Vaporize { confirmation, .. }) => {
                    append_bounded(confirmation, &inserted, 64);
                }
                None => {}
            }
        }
        cx.stop_propagation();
        cx.notify();
        true
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus.is_focused(window) {
            return;
        }
        if self.on_management_key(event, cx) {
            return;
        }
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if modifiers.platform && key == "n" {
            self.open_create();
        } else if modifiers.platform && key == "r" {
            self.send(DesktopCommand::refresh_fleet());
        } else if modifiers.control && key == "c" {
            if let Some(fence) = self.selection_fence() {
                self.send(DesktopCommand::abort(fence));
            }
        } else if key == "escape" {
            self.send(DesktopCommand::close());
        } else if key == "enter" {
            if modifiers.shift {
                if self.draft.len() < MAX_DRAFT_BYTES {
                    self.draft.push('\n');
                    self.sync_draft();
                }
            } else {
                self.submit(modifiers.alt);
            }
        } else if key == "backspace" {
            self.draft.pop();
            self.sync_draft();
        } else if modifiers.platform && key == "v" {
            if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                self.draft.push_str(&text);
                self.draft
                    .truncate(self.draft.floor_char_boundary(MAX_DRAFT_BYTES));
                self.sync_draft();
            }
        } else if !modifiers.platform && !modifiers.control {
            if let Some(text) = event.keystroke.key_char.as_deref()
                && self.draft.len() + text.len() <= MAX_DRAFT_BYTES
            {
                self.draft.push_str(text);
                self.sync_draft();
            }
        } else {
            return;
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn render_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        let selected = self
            .state
            .as_ref()
            .and_then(|state| state.selected_session_id.as_deref());
        let rows = self
            .state
            .as_ref()
            .map(|state| {
                state
                    .fleet
                    .iter()
                    .map(|session| {
                        let id = session.id.clone();
                        let accessibility_label = format!(
                            "{} sandbox, {}, {}, {}",
                            session.title, session.status, session.repo, session.branch
                        );
                        let active = selected == Some(session.id.as_str());
                        let usable = session.usable();
                        let selectable = session.selectable();
                        let status_color = match session.agent_state.as_deref() {
                            Some("waiting") => theme.warning,
                            Some("working") => theme.accent,
                            _ if !usable => theme.text_faint,
                            _ => theme.text_muted,
                        };
                        div()
                            .id(SharedString::from(format!("session-{id}")))
                            .role(Role::Button)
                            .aria_label(SharedString::from(accessibility_label))
                            .focusable()
                            .tab_stop(true)
                            .mx(px(8.0))
                            .mb(px(2.0))
                            .px(px(10.0))
                            .py(px(9.0))
                            .rounded(px(8.0))
                            .bg(if active {
                                theme.element_active
                            } else {
                                gpui::transparent_black()
                            })
                            .when(selectable, |row| {
                                row.cursor_pointer()
                                    .on_click(cx.listener(move |view, _, _, cx| {
                                        view.send(DesktopCommand::select(id.clone()));
                                        cx.notify();
                                    }))
                            })
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_start()
                                    .gap(px(9.0))
                                    .child(
                                        div()
                                            .mt(px(5.0))
                                            .size(px(7.0))
                                            .rounded_full()
                                            .bg(status_color),
                                    )
                                    .child(
                                        div()
                                            .min_w_0()
                                            .flex_1()
                                            .child(
                                                div()
                                                    .text_size(px(13.0))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(if selectable {
                                                        theme.text
                                                    } else {
                                                        theme.text_faint
                                                    })
                                                    .child(SharedString::from(
                                                        session.title.clone(),
                                                    )),
                                            )
                                            .child(
                                                div()
                                                    .mt(px(2.0))
                                                    .text_size(px(10.5))
                                                    .text_color(theme.text_muted)
                                                    .child(SharedString::from(format!(
                                                        "{} · {}",
                                                        project_label(&session.repo),
                                                        session.branch
                                                    ))),
                                            )
                                            .child(
                                                div()
                                                    .mt(px(2.0))
                                                    .text_size(px(9.5))
                                                    .text_color(theme.text_faint)
                                                    .child(SharedString::from(format!(
                                                        "{} · {}",
                                                        session.status.to_uppercase(),
                                                        session.updated_at
                                                    ))),
                                            ),
                                    ),
                            )
                            .into_any_element()
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        div()
            .w(px(286.0))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .border_r_1()
            .border_color(theme.border)
            .child(
                div()
                    .h(px(54.0))
                    .flex_none()
                    .px(px(18.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .child(
                                div()
                                    .text_size(px(13.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("SCOTTY"),
                            )
                            .child(
                                div()
                                    .text_size(px(9.0))
                                    .text_color(theme.text_faint)
                                    .child("REMOTE FLEET"),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .id("new-sandbox")
                                    .role(Role::Button)
                                    .aria_label("Create sandbox")
                                    .focusable()
                                    .tab_stop(true)
                                    .px(px(8.0))
                                    .py(px(5.0))
                                    .rounded(px(6.0))
                                    .bg(theme.accent.opacity(0.16))
                                    .cursor_pointer()
                                    .text_size(px(10.0))
                                    .text_color(theme.accent)
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.open_create();
                                        cx.notify();
                                    }))
                                    .child("+ NEW"),
                            )
                            .child(
                                div()
                                    .id("refresh-fleet")
                                    .role(Role::Button)
                                    .aria_label("Refresh sandbox fleet")
                                    .focusable()
                                    .tab_stop(true)
                                    .px(px(8.0))
                                    .py(px(5.0))
                                    .rounded(px(6.0))
                                    .bg(theme.element_hover)
                                    .cursor_pointer()
                                    .text_size(px(10.0))
                                    .text_color(theme.text_muted)
                                    .on_click(cx.listener(|view, _, _, _| {
                                        view.send(DesktopCommand::refresh_fleet())
                                    }))
                                    .child("↻"),
                            ),
                    ),
            )
            .child(
                div()
                    .id("fleet-scroll")
                    .role(Role::List)
                    .aria_label("Scotty sandboxes")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .children(rows),
            )
            .when(
                self.state
                    .as_ref()
                    .is_some_and(|state| state.fleet.is_empty()),
                |panel| {
                    panel.child(
                        div()
                            .p(px(18.0))
                            .text_size(px(12.0))
                            .text_color(theme.text_muted)
                            .child("No Scotty sessions are listed."),
                    )
                },
            )
    }

    fn render_transcript_row(
        &mut self,
        index: usize,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = Theme::of(cx).clone();
        let Some((session_id, item)) = self.state.as_ref().and_then(|state| {
            let session_id = state.selected_session_id.clone()?;
            let item = state
                .selected
                .as_ref()?
                .live
                .as_ref()?
                .transcript
                .get(index)?
                .clone();
            Some((session_id, item))
        }) else {
            return div().into_any_element();
        };
        let tool_expanded = match &item {
            TranscriptItem::Tool { id, .. } => self.tool_expanded(&session_id, id),
            _ => false,
        };
        render_transcript_item(index, &item, &session_id, tool_expanded, &theme, cx)
    }

    fn tool_expanded(&self, session_id: &str, tool_id: &str) -> bool {
        self.tool_expansions.is_expanded(session_id, tool_id)
    }

    fn toggle_tool(&mut self, session_id: &str, tool_id: &str) {
        self.tool_expansions.toggle(session_id, tool_id);
    }

    fn render_main(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        let selected_id = self
            .state
            .as_ref()
            .and_then(|state| state.selected_session_id.as_deref());
        let selected = self
            .state
            .as_ref()
            .and_then(|state| state.selected.as_ref());
        let selected_row = selected
            .and_then(|selected| selected.metadata.as_ref())
            .or_else(|| {
                selected_id.and_then(|id| {
                    self.state
                        .as_ref()?
                        .fleet
                        .iter()
                        .find(|session| session.id == id)
                })
            });
        let title = selected_row
            .map(|session| session.title.clone())
            .unwrap_or_else(|| "Choose a session".into());
        let subtitle = selected_row
            .map(|session| {
                format!(
                    "{} · {} → {} · {} · cap {}",
                    session.repo,
                    session.branch,
                    session.default_branch,
                    session.status,
                    session
                        .cap_remaining_seconds
                        .map(format_seconds)
                        .unwrap_or_else(|| "unknown".into())
                )
            })
            .unwrap_or_else(|| {
                "Every remote session remains active while you move between them.".into()
            });
        let inspector = selected_row.map(|session| {
            format!(
                "id {} · age {} · created {} · hard cap {} · synced {} · backup {}",
                session.id,
                session
                    .age_seconds
                    .map(format_seconds)
                    .unwrap_or_else(|| "unknown".into()),
                session.created_at,
                session.hard_cap_at,
                session.projected_at,
                session.backup_id.as_deref().unwrap_or("none")
            )
        });
        let transcript_truncated = selected
            .and_then(|selected| selected.live.as_ref())
            .is_some_and(|live| live.sidecar_truncated);
        let activity = selected
            .and_then(|selected| selected.live.as_ref())
            .map(|live| live.activity.as_str())
            .unwrap_or("idle");
        let fence = make_selection_fence(selected_id, selected);
        let pending = fence.zip(
            selected
                .and_then(|selected| selected.live.as_ref())
                .and_then(|live| live.pending_ui.first()),
        );
        let loading = self.state.as_ref().is_some_and(|state| state.loading);
        let session_failure = selected_row.and_then(|session| {
            session.failure.as_ref().map(|failure| {
                format!(
                    "{}: {}{}",
                    failure.code,
                    failure.message,
                    if failure.recoverable {
                        " (recoverable)"
                    } else {
                        ""
                    }
                )
            })
        });
        let error = self
            .state
            .as_ref()
            .and_then(|state| state.fleet_error.as_deref())
            .or_else(|| selected.and_then(|selected| selected.error.as_deref()))
            .or_else(|| {
                selected
                    .and_then(|selected| selected.unavailable.as_ref())
                    .map(|unavailable| unavailable.reason.as_str())
            })
            .or(session_failure.as_deref())
            .or(self.command_error.as_deref());
        let selected_identity =
            selected_row.map(|session| (session.id.clone(), session.title.clone()));
        let operation_running = self.operation_running();
        let can_snapshot = selected_row.is_some_and(|session| session.status == "warm")
            && selected
                .and_then(|selected| selected.live.as_ref())
                .is_some_and(|live| !live.is_streaming && live.activity != "working");
        let can_resume = selected_row.is_some_and(|session| {
            matches!(session.status.as_str(), "sleeping" | "failed") && session.backup_id.is_some()
        });

        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .bg(theme.bg)
            .child(
                div()
                    .h(px(78.0))
                    .flex_none()
                    .px(px(22.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(
                        div()
                            .min_w_0()
                            .child(
                                div()
                                    .text_size(px(15.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(SharedString::from(title)),
                            )
                            .child(
                                div()
                                    .mt(px(2.0))
                                    .text_size(px(10.5))
                                    .text_color(theme.text_muted)
                                    .child(SharedString::from(subtitle)),
                            )
                            .when_some(inspector, |header, inspector| {
                                header.child(
                                    div()
                                        .mt(px(2.0))
                                        .text_size(px(9.0))
                                        .text_color(theme.text_faint)
                                        .font_family(theme.font_mono.clone())
                                        .child(SharedString::from(inspector)),
                                )
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .px(px(9.0))
                                    .py(px(5.0))
                                    .rounded_full()
                                    .bg(theme.element_hover)
                                    .text_size(px(9.5))
                                    .text_color(match activity {
                                        "working" => theme.accent,
                                        "waiting" => theme.warning,
                                        _ => theme.text_muted,
                                    })
                                    .child(SharedString::from(activity.to_uppercase())),
                            )
                            .when_some(
                                selected_identity.clone().filter(|_| !operation_running),
                                |actions, (id, title)| {
                                let rename_id = id.clone();
                                let rename_title = title.clone();
                                actions.child(
                                    div()
                                        .id("rename-sandbox")
                                        .role(Role::Button)
                                        .aria_label("Rename selected sandbox")
                                        .focusable()
                                        .tab_stop(true)
                                        .px(px(8.0))
                                        .py(px(5.0))
                                        .rounded(px(6.0))
                                        .bg(theme.element_hover)
                                        .cursor_pointer()
                                        .text_size(px(9.5))
                                        .text_color(theme.text_muted)
                                        .on_click(cx.listener(move |view, _, _, cx| {
                                            view.open_rename(rename_id.clone(), rename_title.clone());
                                            cx.notify();
                                        }))
                                        .child("RENAME"),
                                )
                            },
                            )
                            .when_some(
                                selected_identity
                                    .clone()
                                    .filter(|_| can_snapshot && !operation_running),
                                |actions, (id, _)| {
                                    actions.child(
                                        div()
                                            .id("snapshot-sandbox")
                                            .role(Role::Button)
                                            .aria_label("Snapshot selected sandbox")
                                            .focusable()
                                            .tab_stop(true)
                                            .px(px(8.0))
                                            .py(px(5.0))
                                            .rounded(px(6.0))
                                            .bg(theme.element_hover)
                                            .cursor_pointer()
                                            .text_size(px(9.5))
                                            .text_color(theme.text_muted)
                                            .on_click(cx.listener(move |view, _, _, _| {
                                                let request_id = view.next_request_id("snapshot");
                                                view.send(DesktopCommand::snapshot_sandbox(
                                                    request_id,
                                                    id.clone(),
                                                ));
                                            }))
                                            .child("SNAPSHOT"),
                                    )
                                },
                            )
                            .when_some(
                                selected_identity
                                    .clone()
                                    .filter(|_| can_resume && !operation_running),
                                |actions, (id, _)| {
                                    actions.child(
                                        div()
                                            .id("resume-sandbox")
                                            .role(Role::Button)
                                            .aria_label("Resume selected sandbox")
                                            .focusable()
                                            .tab_stop(true)
                                            .px(px(8.0))
                                            .py(px(5.0))
                                            .rounded(px(6.0))
                                            .bg(theme.accent.opacity(0.12))
                                            .cursor_pointer()
                                            .text_size(px(9.5))
                                            .text_color(theme.accent)
                                            .on_click(cx.listener(move |view, _, _, _| {
                                                let request_id = view.next_request_id("resume");
                                                view.send(DesktopCommand::resume_sandbox(
                                                    request_id,
                                                    id.clone(),
                                                ));
                                            }))
                                            .child("RESUME"),
                                    )
                                },
                            )
                            .when_some(
                                selected_identity.filter(|_| !operation_running),
                                |actions, (id, title)| {
                                actions.child(
                                    div()
                                        .id("vaporize-sandbox")
                                        .role(Role::Button)
                                        .aria_label("Vaporize selected sandbox")
                                        .focusable()
                                        .tab_stop(true)
                                        .px(px(8.0))
                                        .py(px(5.0))
                                        .rounded(px(6.0))
                                        .cursor_pointer()
                                        .text_size(px(9.5))
                                        .text_color(theme.danger)
                                        .on_click(cx.listener(move |view, _, _, cx| {
                                            view.open_vaporize(id.clone(), title.clone());
                                            cx.notify();
                                        }))
                                        .child("VAPORIZE"),
                                )
                            },
                            ),
                    ),
            )
            .child(
                div()
                    .id("transcript-scroll")
                    .role(Role::Log)
                    .aria_label("Selected sandbox transcript")
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .when(transcript_truncated, |content| {
                        content.child(render_truncation_notice(&theme))
                    })
                    .when(self.unseen_transcript > 0, |content| {
                        let count = self.unseen_transcript;
                        content.child(
                            div()
                                .id("jump-to-latest")
                                .role(Role::Button)
                                .aria_label(SharedString::from(format!(
                                    "{count} new transcript items; jump to latest"
                                )))
                                .focusable()
                                .tab_stop(true)
                                .absolute()
                                .top(px(12.0))
                                .right(px(20.0))
                                .px(px(11.0))
                                .py(px(7.0))
                                .rounded(px(7.0))
                                .bg(theme.surface_raised)
                                .border_1()
                                .border_color(theme.accent.opacity(0.35))
                                .text_size(px(10.0))
                                .text_color(theme.accent)
                                .cursor_pointer()
                                .on_click(cx.listener(|view, _, _, cx| {
                                    view.transcript_list.scroll_to_end();
                                    view.transcript_list.set_follow_mode(FollowMode::Tail);
                                    view.unseen_transcript = 0;
                                    cx.notify();
                                }))
                                .child(SharedString::from(format!("{count} NEW · LATEST"))),
                        )
                    })
                    .when(selected_id.is_some(), |content| {
                        content.child(
                            list(
                                self.transcript_list.clone(),
                                cx.processor(Self::render_transcript_row),
                            )
                            .flex_1()
                            .min_h_0()
                            .with_sizing_behavior(gpui::ListSizingBehavior::Auto),
                        )
                    })
                    .when(
                        selected
                            .and_then(|selected| selected.live.as_ref())
                            .is_some_and(|live| live.is_streaming),
                        |content| content.child(render_working(&theme)),
                    )
                    .when(selected_id.is_none(), |content| {
                        content.child(
                            div()
                                .h_full()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(
                                    div()
                                        .w(px(430.0))
                                        .text_center()
                                        .child(
                                            div()
                                                .text_size(px(28.0))
                                                .font_weight(FontWeight::MEDIUM)
                                                .child("Your sessions, still in motion."),
                                        )
                                        .child(
                                            div()
                                                .mt(px(12.0))
                                                .text_size(px(13.0))
                                                .text_color(theme.text_muted)
                                                .child("Select any sandbox to inspect it. Warm sessions attach passively; cold sessions stay stopped until you choose Resume."),
                                        ),
                                ),
                        )
                    })
                    .when(loading, |content| {
                        content.child(
                            div()
                                .mx(px(22.0))
                                .text_size(px(12.0))
                                .text_color(theme.text_muted)
                                .child("Connecting to the existing supervisor…"),
                        )
                    })
                    .when_some(error, |content, error| {
                        content.child(
                            div()
                                .mx(px(22.0))
                                .px(px(12.0))
                                .py(px(10.0))
                                .rounded(px(8.0))
                                .bg(theme.danger.opacity(0.08))
                                .text_size(px(11.0))
                                .text_color(theme.danger)
                                .child(SharedString::from(error.to_string())),
                        )
                    }),
            )
            .when_some(pending, |panel, (fence, pending)| {
                panel.child(self.render_pending(fence, pending, cx))
            })
            .child(self.render_composer(selected_id, selected, cx))
    }

    fn render_management_panel(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = Theme::of(cx).clone();
        let Some(panel) = &self.management_panel else {
            return div().into_any_element();
        };
        let cancel = div()
            .id("cancel-management")
            .role(Role::Button)
            .aria_label("Cancel sandbox operation")
            .focusable()
            .tab_stop(true)
            .px(px(10.0))
            .py(px(7.0))
            .rounded(px(7.0))
            .cursor_pointer()
            .text_size(px(10.0))
            .text_color(theme.text_muted)
            .on_click(cx.listener(|view, _, _, cx| {
                view.management_panel = None;
                cx.notify();
            }))
            .child("CANCEL");
        let body = match panel {
            ManagementPanel::Create {
                field,
                title,
                repo,
                prompt,
                hard_cap,
            } => div()
                .child(management_field(
                    "create-title",
                    "Title",
                    title,
                    *field == CreateField::Title,
                    false,
                    &theme,
                ))
                .child(management_field(
                    "create-repository",
                    "Repository",
                    repo,
                    *field == CreateField::Repo,
                    false,
                    &theme,
                ))
                .child(management_field(
                    "create-prompt",
                    "Initial prompt",
                    prompt,
                    *field == CreateField::Prompt,
                    true,
                    &theme,
                ))
                .child(management_field(
                    "create-hard-cap",
                    "Hard cap",
                    hard_cap,
                    *field == CreateField::HardCap,
                    false,
                    &theme,
                ))
                .child(
                    div()
                        .mt(px(12.0))
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(9.5))
                                .text_color(theme.text_faint)
                                .child("Tab fields · ⌘Enter create · cap: 30m, 4h, 1d"),
                        )
                        .child(
                            div().flex().gap(px(6.0)).child(cancel).child(
                                div()
                                    .id("submit-create")
                                    .role(Role::Button)
                                    .aria_label("Create sandbox")
                                    .focusable()
                                    .tab_stop(true)
                                    .px(px(11.0))
                                    .py(px(7.0))
                                    .rounded(px(7.0))
                                    .bg(theme.accent.opacity(0.18))
                                    .cursor_pointer()
                                    .text_size(px(10.0))
                                    .text_color(theme.accent)
                                    .on_click(cx.listener(|view, _, _, cx| {
                                        view.submit_management();
                                        cx.notify();
                                    }))
                                    .child("CREATE SANDBOX"),
                            ),
                        ),
                ),
            ManagementPanel::Rename { title, .. } => div()
                .child(management_field(
                    "rename-title",
                    "Sandbox title",
                    title,
                    true,
                    false,
                    &theme,
                ))
                .child(
                    div()
                        .mt(px(12.0))
                        .flex()
                        .justify_end()
                        .gap(px(6.0))
                        .child(cancel)
                        .child(
                            div()
                                .id("submit-rename")
                                .role(Role::Button)
                                .aria_label("Save sandbox title")
                                .focusable()
                                .tab_stop(true)
                                .px(px(11.0))
                                .py(px(7.0))
                                .rounded(px(7.0))
                                .bg(theme.accent.opacity(0.18))
                                .cursor_pointer()
                                .text_size(px(10.0))
                                .text_color(theme.accent)
                                .on_click(cx.listener(|view, _, _, cx| {
                                    view.submit_management();
                                    cx.notify();
                                }))
                                .child("SAVE"),
                        ),
                ),
            ManagementPanel::Vaporize {
                session_id,
                title,
                confirmation,
            } => div()
                .child(
                    div()
                        .mb(px(12.0))
                        .p(px(10.0))
                        .rounded(px(8.0))
                        .bg(theme.danger.opacity(0.08))
                        .text_size(px(11.0))
                        .text_color(theme.danger)
                        .child(SharedString::from(format!(
                            "Permanently delete {title}. This cannot be undone."
                        ))),
                )
                .child(
                    div()
                        .text_size(px(10.0))
                        .text_color(theme.text_muted)
                        .child("Type the sandbox ID to confirm:"),
                )
                .child(
                    div()
                        .mt(px(4.0))
                        .font_family(theme.font_mono.clone())
                        .text_size(px(10.0))
                        .text_color(theme.text_faint)
                        .child(SharedString::from(session_id.clone())),
                )
                .child(management_field(
                    "vaporize-confirmation",
                    "Confirmation",
                    confirmation,
                    true,
                    false,
                    &theme,
                ))
                .child(
                    div()
                        .mt(px(12.0))
                        .flex()
                        .justify_end()
                        .gap(px(6.0))
                        .child(cancel)
                        .child(
                            div()
                                .id("confirm-vaporize")
                                .role(Role::Button)
                                .aria_label("Confirm permanent sandbox deletion")
                                .focusable()
                                .tab_stop(true)
                                .px(px(11.0))
                                .py(px(7.0))
                                .rounded(px(7.0))
                                .bg(theme.danger.opacity(0.12))
                                .cursor_pointer()
                                .text_size(px(10.0))
                                .text_color(theme.danger)
                                .on_click(cx.listener(|view, _, _, cx| {
                                    view.submit_management();
                                    cx.notify();
                                }))
                                .child("VAPORIZE"),
                        ),
                ),
        };
        let heading = match panel {
            ManagementPanel::Create { .. } => "New sandbox",
            ManagementPanel::Rename { .. } => "Rename sandbox",
            ManagementPanel::Vaporize { .. } => "Vaporize sandbox",
        };
        div()
            .absolute()
            .top(px(76.0))
            .right(px(24.0))
            .w(px(430.0))
            .p(px(16.0))
            .rounded(px(12.0))
            .border_1()
            .border_color(theme.border_strong)
            .bg(theme.surface_raised)
            .shadow_lg()
            .child(
                div()
                    .mb(px(14.0))
                    .text_size(px(14.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(heading),
            )
            .child(body)
            .into_any_element()
    }

    fn render_pending(
        &self,
        fence: SelectionFence,
        pending: &PendingUi,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        let id = pending.id().to_string();
        let body = match pending {
            PendingUi::Select { options, .. } => div().children(
                options
                    .iter()
                    .enumerate()
                    .map(|(index, option)| {
                        let fence = fence.clone();
                        let request_id = id.clone();
                        let value = option.clone();
                        div()
                            .id(("pending-option", index))
                            .role(Role::Button)
                            .aria_label(SharedString::from(option.clone()))
                            .focusable()
                            .tab_stop(true)
                            .mt(px(7.0))
                            .px(px(10.0))
                            .py(px(8.0))
                            .rounded(px(7.0))
                            .bg(theme.element_hover)
                            .cursor_pointer()
                            .on_click(cx.listener(move |view, _, _, _| {
                                view.send(DesktopCommand::answer_value(
                                    fence.clone(),
                                    request_id.clone(),
                                    value.clone(),
                                ))
                            }))
                            .child(SharedString::from(option.clone()))
                    })
                    .collect::<Vec<_>>(),
            ),
            PendingUi::Confirm { message, .. } => div()
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(theme.text_muted)
                        .child(SharedString::from(message.clone())),
                )
                .child(
                    div()
                        .mt(px(8.0))
                        .flex()
                        .gap(px(8.0))
                        .child(confirm_button(
                            "No",
                            fence.clone(),
                            id.clone(),
                            false,
                            &theme,
                            cx,
                        ))
                        .child(confirm_button(
                            "Yes",
                            fence.clone(),
                            id.clone(),
                            true,
                            &theme,
                            cx,
                        )),
                ),
            PendingUi::Input { placeholder, .. } => div()
                .text_size(px(11.0))
                .text_color(theme.text_muted)
                .child(SharedString::from(placeholder.clone().unwrap_or_else(
                    || "Type your answer below and press Enter.".into(),
                ))),
            PendingUi::Editor { prefill, .. } => div()
                .text_size(px(11.0))
                .text_color(theme.text_muted)
                .child(SharedString::from(prefill.clone().unwrap_or_else(|| {
                    "Type your answer below and press Enter.".into()
                }))),
        };
        let cancel_fence = fence;
        let cancel_id = id;
        div()
            .mx(px(22.0))
            .mb(px(10.0))
            .p(px(12.0))
            .rounded(px(10.0))
            .border_1()
            .border_color(theme.warning.opacity(0.35))
            .bg(theme.warning.opacity(0.06))
            .child(
                div()
                    .flex()
                    .justify_between()
                    .child(
                        div()
                            .text_size(px(12.0))
                            .font_weight(FontWeight::MEDIUM)
                            .child(SharedString::from(pending.title().to_string())),
                    )
                    .child(
                        div()
                            .id("cancel-pending")
                            .role(Role::Button)
                            .aria_label("Cancel pending sandbox request")
                            .focusable()
                            .tab_stop(true)
                            .cursor_pointer()
                            .text_size(px(10.0))
                            .text_color(theme.text_muted)
                            .on_click(cx.listener(move |view, _, _, _| {
                                view.send(DesktopCommand::answer_cancelled(
                                    cancel_fence.clone(),
                                    cancel_id.clone(),
                                ))
                            }))
                            .child("CANCEL"),
                    ),
            )
            .child(body)
    }

    fn render_composer(
        &self,
        selected_session_id: Option<&str>,
        selected: Option<&sidecar::SelectedState>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        let abort_fence = make_selection_fence(selected_session_id, selected);
        let enabled = abort_fence.is_some();
        let status = selected.and_then(|selected| selected.command_status.as_deref());
        let streaming = selected
            .and_then(|selected| selected.live.as_ref())
            .is_some_and(|live| live.is_streaming);
        div()
            .flex_none()
            .px(px(22.0))
            .pb(px(18.0))
            .pt(px(8.0))
            .child(
                div()
                    .min_h(px(58.0))
                    .px(px(15.0))
                    .py(px(12.0))
                    .rounded(px(16.0))
                    .border_1()
                    .border_color(if enabled {
                        theme.border_strong
                    } else {
                        theme.border
                    })
                    .bg(theme.surface)
                    .child(
                        div()
                            .id("composer-input")
                            .role(Role::TextInput)
                            .aria_label("Message selected sandbox")
                            .aria_value(SharedString::from(self.draft.clone()))
                            .aria_placeholder("Message the selected sandbox")
                            .min_h(px(20.0))
                            .text_size(px(13.0))
                            .text_color(if self.draft.is_empty() {
                                theme.text_faint
                            } else {
                                theme.text
                            })
                            .child(SharedString::from(if !enabled {
                                if selected_session_id.is_some() {
                                    "Resume this sandbox to send a message".into()
                                } else {
                                    "Select a sandbox".into()
                                }
                            } else if self.draft.is_empty() {
                                "Message the selected session…".into()
                            } else {
                                self.draft.clone()
                            })),
                    )
                    .child(
                        div()
                            .mt(px(8.0))
                            .flex()
                            .items_center()
                            .justify_between()
                            .text_size(px(9.5))
                            .text_color(theme.text_faint)
                            .child(SharedString::from(
                                status.unwrap_or("Enter send · ⇧Enter newline · ⌥Enter follow-up"),
                            ))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.0))
                                    .when(streaming, |actions| {
                                        actions.child(
                                            div()
                                                .id("abort-active")
                                                .role(Role::Button)
                                                .aria_label("Abort active sandbox response")
                                                .focusable()
                                                .tab_stop(true)
                                                .px(px(7.0))
                                                .py(px(3.0))
                                                .rounded(px(5.0))
                                                .cursor_pointer()
                                                .text_color(theme.danger)
                                                .on_click(cx.listener(move |view, _, _, _| {
                                                    if let Some(fence) = &abort_fence {
                                                        view.send(DesktopCommand::abort(
                                                            fence.clone(),
                                                        ));
                                                    }
                                                }))
                                                .child("ABORT"),
                                        )
                                    })
                                    .child(
                                        div()
                                            .id("submit-draft")
                                            .role(Role::Button)
                                            .aria_label(if streaming {
                                                "Steer active sandbox"
                                            } else {
                                                "Send message to sandbox"
                                            })
                                            .focusable()
                                            .tab_stop(true)
                                            .px(px(7.0))
                                            .py(px(3.0))
                                            .rounded(px(5.0))
                                            .cursor_pointer()
                                            .text_color(if enabled {
                                                theme.accent
                                            } else {
                                                theme.text_faint
                                            })
                                            .on_click(cx.listener(move |view, _, _, cx| {
                                                if enabled {
                                                    view.submit(false);
                                                    cx.notify();
                                                }
                                            }))
                                            .child(if streaming { "STEER" } else { "SEND" }),
                                    ),
                            ),
                    ),
            )
    }
}

impl Drop for DesktopView {
    fn drop(&mut self) {
        self.send(DesktopCommand::shutdown());
        if let Some(shutdown) = &self.shutdown {
            let _ = shutdown.send(true);
        }
    }
}

impl Focusable for DesktopView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for DesktopView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if window.focused(cx).is_none() {
            window.focus(&self.focus, cx);
        }
        let theme = Theme::of(cx).clone();
        let connection = match &self.connection {
            ConnectionStatus::Connecting => Some("Starting desktop sidecar…"),
            ConnectionStatus::Failed(message) => Some(message.as_str()),
            ConnectionStatus::Stopped => Some("Desktop sidecar stopped"),
            ConnectionStatus::Ready => None,
        };
        let operation = self.operation.as_ref().map(|operation| {
            let identity = operation
                .session_id
                .as_deref()
                .unwrap_or(operation.request_id.as_str());
            (
                format!(
                    "{} · {} · {}",
                    action_label(operation.action),
                    identity,
                    operation.message
                ),
                operation.status,
            )
        });
        div()
            .id("scotty-desktop-root")
            .role(Role::Application)
            .aria_label("Scotty Desktop")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key_down))
            .size_full()
            .relative()
            .flex()
            .flex_row()
            .bg(theme.glass())
            .text_color(theme.text)
            .font_family(theme.font_sans)
            .text_size(px(14.0))
            .child(self.render_sidebar(cx))
            .child(self.render_main(cx))
            .when_some(operation, |root, (message, status)| {
                root.child(
                    div()
                        .id("operation-notice")
                        .absolute()
                        .top(px(68.0))
                        .left(px(308.0))
                        .px(px(10.0))
                        .py(px(7.0))
                        .rounded(px(7.0))
                        .bg(theme.surface_raised)
                        .border_1()
                        .role(Role::Status)
                        .aria_label(SharedString::from(message.clone()))
                        .border_color(match status {
                            OperationStatus::Failed => theme.danger.opacity(0.45),
                            OperationStatus::Succeeded => theme.accent.opacity(0.35),
                            OperationStatus::Started | OperationStatus::Unknown => {
                                theme.warning.opacity(0.35)
                            }
                        })
                        .text_size(px(10.0))
                        .text_color(match status {
                            OperationStatus::Failed => theme.danger,
                            OperationStatus::Succeeded => theme.accent,
                            OperationStatus::Started | OperationStatus::Unknown => theme.warning,
                        })
                        .when(status != OperationStatus::Started, |notice| {
                            notice.focusable().tab_stop(true).cursor_pointer().on_click(
                                cx.listener(|view, _, _, cx| {
                                    view.operation = None;
                                    cx.notify();
                                }),
                            )
                        })
                        .child(SharedString::from(message)),
                )
            })
            .when(self.management_panel.is_some(), |root| {
                root.child(self.render_management_panel(cx))
            })
            .when_some(connection, |root, message| {
                root.child(
                    div()
                        .absolute()
                        .left(px(304.0))
                        .bottom(px(18.0))
                        .px(px(10.0))
                        .py(px(7.0))
                        .rounded(px(7.0))
                        .bg(theme.surface_raised)
                        .border_1()
                        .border_color(theme.border)
                        .text_size(px(10.0))
                        .text_color(theme.text_muted)
                        .child(SharedString::from(message.to_string())),
                )
            })
    }
}

fn confirm_button(
    label: &'static str,
    fence: SelectionFence,
    request_id: String,
    value: bool,
    theme: &Theme,
    cx: &mut Context<DesktopView>,
) -> gpui::AnyElement {
    div()
        .id(SharedString::from(format!("confirm-{label}")))
        .role(Role::Button)
        .aria_label(label)
        .focusable()
        .tab_stop(true)
        .px(px(11.0))
        .py(px(6.0))
        .rounded(px(7.0))
        .bg(theme.element_hover)
        .cursor_pointer()
        .on_click(cx.listener(move |view, _, _, _| {
            view.send(DesktopCommand::answer_confirmed(
                fence.clone(),
                request_id.clone(),
                value,
            ))
        }))
        .child(label)
        .into_any_element()
}

fn management_field(
    id: &'static str,
    label: &'static str,
    value: &str,
    active: bool,
    multiline: bool,
    theme: &Theme,
) -> gpui::AnyElement {
    div()
        .mt(px(10.0))
        .child(
            div()
                .mb(px(5.0))
                .text_size(px(10.0))
                .text_color(theme.text_muted)
                .child(label),
        )
        .child(
            div()
                .id(id)
                .role(Role::TextInput)
                .aria_label(label)
                .aria_value(SharedString::from(value.to_string()))
                .aria_placeholder("Type here")
                .min_h(if multiline { px(92.0) } else { px(34.0) })
                .px(px(10.0))
                .py(px(8.0))
                .rounded(px(7.0))
                .border_1()
                .border_color(if active {
                    theme.accent.opacity(0.65)
                } else {
                    theme.border
                })
                .bg(theme.bg)
                .text_size(px(11.5))
                .text_color(if value.is_empty() {
                    theme.text_faint
                } else {
                    theme.text
                })
                .child(SharedString::from(if value.is_empty() {
                    "Type here…".into()
                } else {
                    value.to_string()
                })),
        )
        .into_any_element()
}

fn append_bounded(target: &mut String, value: &str, max_bytes: usize) {
    if target.len() >= max_bytes {
        return;
    }
    let available = max_bytes - target.len();
    let end = value.floor_char_boundary(available.min(value.len()));
    target.push_str(&value[..end]);
}

fn valid_repo(repo: &str) -> bool {
    let Some((owner, name)) = repo.split_once('/') else {
        return false;
    };
    !owner.is_empty()
        && !name.is_empty()
        && !name.contains('/')
        && owner
            .chars()
            .chain(name.chars())
            .all(|character| character.is_ascii_alphanumeric() || "_.-".contains(character))
}

fn parse_hard_cap(value: &str) -> Result<u64, &'static str> {
    let value = value.trim().to_ascii_lowercase();
    let (number, multiplier) = if let Some(number) = value.strip_suffix('m') {
        (number, 60)
    } else if let Some(number) = value.strip_suffix('h') {
        (number, 60 * 60)
    } else if let Some(number) = value.strip_suffix('d') {
        (number, 24 * 60 * 60)
    } else {
        (value.as_str(), 1)
    };
    let seconds = number
        .parse::<u64>()
        .ok()
        .and_then(|number| number.checked_mul(multiplier))
        .ok_or("Hard cap must be seconds or a duration such as 30m, 4h, or 1d")?;
    if (60..=24 * 60 * 60).contains(&seconds) {
        Ok(seconds)
    } else {
        Err("Hard cap must be between 1 minute and 1 day")
    }
}

fn format_seconds(seconds: f64) -> String {
    let seconds = seconds.max(0.0).round() as u64;
    if seconds >= 24 * 60 * 60 {
        format!("{}d", seconds / (24 * 60 * 60))
    } else if seconds >= 60 * 60 {
        format!("{}h", seconds / (60 * 60))
    } else if seconds >= 60 {
        format!("{}m", seconds / 60)
    } else {
        format!("{seconds}s")
    }
}

fn action_label(action: ManagementAction) -> &'static str {
    match action {
        ManagementAction::Create => "Create",
        ManagementAction::Rename => "Rename",
        ManagementAction::Snapshot => "Snapshot",
        ManagementAction::Resume => "Resume",
        ManagementAction::Vaporize => "Vaporize",
    }
}

fn should_apply_draft(selection_changed: bool, incoming: u64, current: u64) -> bool {
    selection_changed || incoming > current
}

fn tool_key(session_id: &str, tool_id: &str) -> String {
    format!("{session_id}\u{1f}{tool_id}")
}

fn make_selection_fence(
    session_id: Option<&str>,
    selected: Option<&sidecar::SelectedState>,
) -> Option<SelectionFence> {
    let live = selected?.live.as_ref()?;
    Some(SelectionFence {
        session_id: session_id?.to_string(),
        expected_epoch: live.epoch.clone(),
        expected_session_revision: live.session_revision,
    })
}

fn render_transcript_item(
    index: usize,
    item: &TranscriptItem,
    session_id: &str,
    tool_expanded: bool,
    theme: &Theme,
    cx: &mut Context<DesktopView>,
) -> gpui::AnyElement {
    let row = div()
        .id(SharedString::from(format!("transcript-{}", item.id())))
        .w_full()
        .px(px(48.0))
        .when(index == 0, |row| row.pt(px(26.0)))
        .mb(px(14.0))
        .flex()
        .justify_center();
    let column = div().w_full().max_w(px(768.0)).min_w_0();

    match item {
        TranscriptItem::User { text, .. } => row
            .child(
                column.flex().justify_end().child(
                    div()
                        .max_w(px(620.0))
                        .px(px(14.0))
                        .py(px(11.0))
                        .rounded(px(14.0))
                        .bg(theme.element_active)
                        .border_1()
                        .border_color(theme.border_strong)
                        .child(
                            div()
                                .mb(px(5.0))
                                .text_size(px(9.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.accent.opacity(0.9))
                                .child("YOU"),
                        )
                        .child(
                            div()
                                .text_size(px(13.0))
                                .text_color(theme.text)
                                .child(SharedString::from(truncate(text, 16_000))),
                        ),
                ),
            )
            .into_any_element(),
        TranscriptItem::Assistant { text, .. } => row
            .mb(px(18.0))
            .child(column.child(render_markdown(text, theme, false)))
            .into_any_element(),
        TranscriptItem::Thinking { text, .. } => row
            .mb(px(10.0))
            .child(
                column.child(
                    div()
                        .flex()
                        .items_start()
                        .gap(px(9.0))
                        .px(px(2.0))
                        .text_size(px(11.5))
                        .text_color(theme.text_muted.opacity(0.72))
                        .child(
                            div()
                                .mt(px(5.0))
                                .size(px(6.0))
                                .rounded_full()
                                .bg(theme.accent.opacity(0.55)),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .child(
                                    div()
                                        .mb(px(3.0))
                                        .text_size(px(9.0))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(theme.text_faint)
                                        .child("REASONING"),
                                )
                                .child(render_markdown(text, theme, true)),
                        ),
                ),
            )
            .into_any_element(),
        TranscriptItem::Tool {
            id,
            name,
            summary,
            detail,
            status,
            result,
        } => row
            .mb(px(8.0))
            .child(column.child(render_tool(
                ToolView {
                    row_index: index,
                    session_id,
                    id,
                    name,
                    summary,
                    detail: detail.as_deref(),
                    status: *status,
                    result: result.as_deref(),
                    expanded: tool_expanded,
                },
                theme,
                cx,
            )))
            .into_any_element(),
        TranscriptItem::Error { message, .. } => row
            .mb(px(10.0))
            .child(column.child(render_error(message, theme)))
            .into_any_element(),
        TranscriptItem::Notice {
            title,
            message,
            tone,
            ..
        } => row
            .mb(px(10.0))
            .child(column.child(render_notice(title, message, *tone, theme)))
            .into_any_element(),
        TranscriptItem::Fallback { text, .. } => row
            .mb(px(9.0))
            .child(
                column.child(
                    div()
                        .rounded(px(9.0))
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.surface.opacity(0.72))
                        .px(px(10.0))
                        .py(px(8.0))
                        .text_size(px(11.0))
                        .text_color(theme.text_muted)
                        .child(SharedString::from(truncate(text, 2_000))),
                ),
            )
            .into_any_element(),
    }
}

fn render_markdown(source: &str, theme: &Theme, muted: bool) -> gpui::AnyElement {
    let source = truncate(source, 16_000);
    let blocks = parse_markdown(&source);
    div()
        .px(px(2.0))
        .flex()
        .flex_col()
        .gap(px(9.0))
        .children(
            blocks
                .into_iter()
                .map(|block| render_markdown_block(block, theme, muted))
                .collect::<Vec<_>>(),
        )
        .into_any_element()
}

fn render_markdown_block(block: MarkdownBlock, theme: &Theme, muted: bool) -> gpui::AnyElement {
    let text_color = if muted {
        theme.text_muted.opacity(0.78)
    } else {
        theme.text
    };
    let content = styled_markdown_text(&block, theme, text_color);
    match block.kind {
        MarkdownBlockKind::Heading(level) => div()
            .mt(if level <= 2 { px(4.0) } else { px(1.0) })
            .text_size(match level {
                1 => px(21.0),
                2 => px(18.0),
                3 => px(16.0),
                _ => px(14.0),
            })
            .line_height(match level {
                1 => px(28.0),
                2 => px(25.0),
                _ => px(22.0),
            })
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(text_color)
            .child(content)
            .into_any_element(),
        MarkdownBlockKind::Quote => div()
            .rounded(px(8.0))
            .border_1()
            .border_color(theme.border)
            .bg(theme.surface.opacity(0.62))
            .px(px(11.0))
            .py(px(8.0))
            .text_size(px(12.5))
            .line_height(px(19.0))
            .text_color(if muted { text_color } else { theme.text_muted })
            .child(content)
            .into_any_element(),
        MarkdownBlockKind::Code => div()
            .rounded(px(8.0))
            .border_1()
            .border_color(theme.border)
            .bg(theme.surface_raised)
            .px(px(11.0))
            .py(px(9.0))
            .font_family(theme.font_mono.clone())
            .text_size(px(11.5))
            .line_height(px(18.0))
            .text_color(text_color.opacity(0.9))
            .child(SharedString::from(block.text))
            .into_any_element(),
        MarkdownBlockKind::ListItem => div()
            .text_size(px(13.0))
            .line_height(px(20.0))
            .text_color(text_color)
            .child(content)
            .into_any_element(),
        MarkdownBlockKind::Rule => div()
            .my(px(5.0))
            .h(px(1.0))
            .w_full()
            .bg(theme.border)
            .into_any_element(),
        MarkdownBlockKind::Paragraph => div()
            .text_size(px(13.0))
            .line_height(px(20.0))
            .text_color(text_color)
            .child(content)
            .into_any_element(),
    }
}

fn styled_markdown_text(
    block: &MarkdownBlock,
    theme: &Theme,
    text_color: gpui::Hsla,
) -> StyledText {
    StyledText::new(SharedString::from(block.text.clone())).with_highlights(
        block.ranges.iter().map(|range| {
            (
                range.range.clone(),
                markdown_highlight(range.style, theme, text_color),
            )
        }),
    )
}

fn markdown_highlight(
    style: MarkdownStyle,
    theme: &Theme,
    text_color: gpui::Hsla,
) -> HighlightStyle {
    HighlightStyle {
        font_weight: style.strong.then_some(FontWeight::SEMIBOLD),
        font_style: style.emphasis.then_some(FontStyle::Italic),
        color: if style.link {
            Some(theme.accent)
        } else if style.code {
            Some(text_color.opacity(0.92))
        } else {
            None
        },
        background_color: style.code.then_some(theme.element_hover),
        ..Default::default()
    }
}

struct ToolView<'a> {
    row_index: usize,
    session_id: &'a str,
    id: &'a str,
    name: &'a str,
    summary: &'a str,
    detail: Option<&'a str>,
    status: ToolStatus,
    result: Option<&'a str>,
    expanded: bool,
}

fn render_tool(
    tool: ToolView<'_>,
    theme: &Theme,
    cx: &mut Context<DesktopView>,
) -> gpui::AnyElement {
    let ToolView {
        row_index,
        session_id,
        id: tool_id,
        name,
        summary,
        detail,
        status,
        result,
        expanded,
    } = tool;
    let (glyph, status_label, tint) = match status {
        ToolStatus::Pending => ("○", "PENDING", theme.text_faint),
        ToolStatus::Running => ("●", "RUNNING", theme.accent),
        ToolStatus::Completed => ("✓", "DONE", theme.text_muted),
        ToolStatus::Failed => ("!", "FAILED", theme.danger),
    };
    let toggle_session = session_id.to_string();
    let toggle_tool = tool_id.to_string();
    let accessibility_label = format!(
        "{} tool call: {}; {}",
        if expanded { "Collapse" } else { "Expand" },
        summary,
        status_label.to_ascii_lowercase()
    );
    div()
        .ml(px(12.0))
        .min_w_0()
        .rounded(px(9.0))
        .border_1()
        .border_color(if status == ToolStatus::Failed {
            theme.danger.opacity(0.18)
        } else {
            theme.border
        })
        .bg(if status == ToolStatus::Failed {
            theme.danger.opacity(0.045)
        } else {
            theme.surface.opacity(0.74)
        })
        .child(
            div()
                .id(SharedString::from(format!(
                    "tool-toggle-{session_id}-{tool_id}"
                )))
                .role(Role::Button)
                .aria_label(SharedString::from(accessibility_label))
                .aria_expanded(expanded)
                .focusable()
                .tab_stop(true)
                .cursor_pointer()
                .flex()
                .items_center()
                .gap(px(9.0))
                .px(px(9.0))
                .py(px(8.0))
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.toggle_tool(&toggle_session, &toggle_tool);
                    view.transcript_list
                        .remeasure_items(row_index..row_index.saturating_add(1));
                    cx.notify();
                }))
                .child(
                    div()
                        .size(px(20.0))
                        .flex_none()
                        .rounded(px(6.0))
                        .bg(tint.opacity(0.12))
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(10.0))
                        .text_color(tint)
                        .child(glyph),
                )
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .items_center()
                        .gap(px(7.0))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(if status == ToolStatus::Failed {
                                    theme.danger
                                } else {
                                    theme.text
                                })
                                .child(SharedString::from(single_line(summary, 180))),
                        )
                        .child(
                            div()
                                .flex_none()
                                .text_size(px(8.5))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(tint)
                                .child(status_label),
                        )
                        .child(
                            div()
                                .flex_none()
                                .text_size(px(9.0))
                                .text_color(theme.text_faint)
                                .child(SharedString::from(single_line(name, 48))),
                        ),
                )
                .child(
                    div()
                        .flex_none()
                        .w(px(14.0))
                        .text_center()
                        .text_size(px(11.0))
                        .text_color(theme.text_faint)
                        .child(if expanded { "⌄" } else { "›" }),
                ),
        )
        .when(expanded, |card| {
            card.child(
                div()
                    .border_t_1()
                    .border_color(theme.border)
                    .px(px(10.0))
                    .py(px(9.0))
                    .when_some(detail, |body, detail| {
                        body.child(tool_detail("INPUT", detail, status, theme))
                    })
                    .when_some(result, |body, result| {
                        body.child(tool_detail("OUTPUT", result, status, theme))
                    })
                    .when(detail.is_none() && result.is_none(), |body| {
                        body.text_size(px(10.5))
                            .text_color(theme.text_faint)
                            .child("No tool details were projected.")
                    }),
            )
        })
        .into_any_element()
}

fn tool_detail(
    label: &'static str,
    value: &str,
    status: ToolStatus,
    theme: &Theme,
) -> gpui::AnyElement {
    div()
        .mb(px(7.0))
        .child(
            div()
                .mb(px(4.0))
                .text_size(px(8.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_faint)
                .child(label),
        )
        .child(
            div()
                .font_family(theme.font_mono.clone())
                .text_size(px(10.5))
                .line_height(px(16.0))
                .text_color(if status == ToolStatus::Failed {
                    theme.danger.opacity(0.9)
                } else {
                    theme.text_muted
                })
                .child(SharedString::from(truncate(value, 8_000))),
        )
        .into_any_element()
}

fn render_error(message: &str, theme: &Theme) -> gpui::AnyElement {
    div()
        .min_h(px(36.0))
        .flex()
        .items_center()
        .gap(px(8.0))
        .overflow_hidden()
        .rounded(px(10.0))
        .border_1()
        .border_color(theme.danger.opacity(0.18))
        .bg(theme.danger.opacity(0.055))
        .px(px(8.0))
        .py(px(7.0))
        .text_size(px(12.0))
        .child(
            div()
                .size(px(20.0))
                .flex_none()
                .rounded(px(6.0))
                .bg(theme.danger.opacity(0.13))
                .flex()
                .items_center()
                .justify_center()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.danger)
                .child("!"),
        )
        .child(
            div()
                .flex_none()
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.danger)
                .child("Error"),
        )
        .child(
            div()
                .min_w_0()
                .flex_1()
                .text_color(theme.text.opacity(0.84))
                .child(SharedString::from(truncate(message, 2_000))),
        )
        .into_any_element()
}

fn render_notice(title: &str, message: &str, tone: NoticeTone, theme: &Theme) -> gpui::AnyElement {
    let tint = if tone == NoticeTone::Warning {
        theme.warning
    } else {
        theme.text_muted
    };
    div()
        .min_h(px(36.0))
        .flex()
        .items_center()
        .gap(px(8.0))
        .rounded(px(10.0))
        .border_1()
        .border_color(tint.opacity(0.16))
        .bg(tint.opacity(0.045))
        .px(px(9.0))
        .py(px(7.0))
        .text_size(px(12.0))
        .child(
            div()
                .flex_none()
                .font_weight(FontWeight::MEDIUM)
                .text_color(tint)
                .child(SharedString::from(title.to_string())),
        )
        .child(
            div()
                .min_w_0()
                .flex_1()
                .text_color(theme.text.opacity(0.82))
                .child(SharedString::from(truncate(message, 4_000))),
        )
        .into_any_element()
}

fn render_truncation_notice(theme: &Theme) -> gpui::AnyElement {
    div()
        .w_full()
        .px(px(48.0))
        .mb(px(14.0))
        .flex()
        .justify_center()
        .child(
            div()
                .w_full()
                .max_w(px(768.0))
                .border_b_1()
                .border_color(theme.border)
                .pb(px(9.0))
                .text_size(px(10.5))
                .text_color(theme.text_faint)
                .child("Some transcript content was truncated."),
        )
        .into_any_element()
}

fn render_working(theme: &Theme) -> gpui::AnyElement {
    div()
        .w_full()
        .px(px(48.0))
        .mb(px(12.0))
        .flex()
        .justify_center()
        .child(
            div()
                .w_full()
                .max_w(px(768.0))
                .flex()
                .items_center()
                .gap(px(7.0))
                .px(px(2.0))
                .text_size(px(10.5))
                .text_color(theme.text_muted.opacity(0.72))
                .child(
                    div()
                        .size(px(6.0))
                        .rounded_full()
                        .bg(theme.accent.opacity(0.7)),
                )
                .child("Working…"),
        )
        .into_any_element()
}

fn single_line(value: &str, max: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(&normalized, max)
}

fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let boundary = value.floor_char_boundary(max);
    format!("{}…", &value[..boundary])
}

fn project_label(repo: &str) -> &str {
    repo.rsplit('/')
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(repo)
}

#[cfg(test)]
mod tests {
    use super::{ToolExpansions, parse_hard_cap, should_apply_draft, valid_repo};

    #[test]
    fn stale_draft_frames_cannot_replace_local_edits() {
        assert!(!should_apply_draft(false, 4, 5));
        assert!(!should_apply_draft(false, 5, 5));
        assert!(should_apply_draft(false, 6, 5));
        assert!(should_apply_draft(true, 0, 5));
    }

    #[test]
    fn tool_expansion_is_stable_and_namespaced_by_session() {
        let mut expansions = ToolExpansions::default();
        assert!(!expansions.is_expanded("session-a", "tool-1"));

        expansions.toggle("session-a", "tool-1");
        assert!(expansions.is_expanded("session-a", "tool-1"));
        assert!(!expansions.is_expanded("session-b", "tool-1"));
        assert!(!expansions.is_expanded("session-a", "tool-2"));

        expansions.toggle("session-a", "tool-1");
        assert!(!expansions.is_expanded("session-a", "tool-1"));
    }

    #[test]
    fn management_inputs_are_normalized_before_crossing_the_sidecar_boundary() {
        assert_eq!(parse_hard_cap("30m"), Ok(1_800));
        assert_eq!(parse_hard_cap("4h"), Ok(14_400));
        assert_eq!(parse_hard_cap("1d"), Ok(86_400));
        assert!(parse_hard_cap("59").is_err());
        assert!(parse_hard_cap("2d").is_err());
        assert!(valid_repo("owner/repo"));
        assert!(!valid_repo("owner/repo/extra"));
        assert!(!valid_repo("owner repo"));
    }
}
