mod app_menus;
mod sidecar;
mod theme;

use std::borrow::Cow;

use gpui::{
    App, AppContext as _, Bounds, Context, FocusHandle, Focusable, FontWeight, IntoElement,
    KeyDownEvent, Render, SharedString, Task, TitlebarOptions, Window, WindowBounds, WindowOptions,
    div, prelude::*, px, size,
};
use gpui_tokio::Tokio;
use sidecar::{
    DesktopCommand, DesktopState, Frame, PendingUi, SelectionFence, SidecarConnection,
    SidecarEvent, ToolStatus, TranscriptItem,
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

struct DesktopView {
    focus: FocusHandle,
    connection: ConnectionStatus,
    state: Option<DesktopState>,
    commands: Option<tokio::sync::mpsc::Sender<DesktopCommand>>,
    shutdown: Option<tokio::sync::watch::Sender<bool>>,
    draft: String,
    draft_generation: u64,
    _events: Task<()>,
}

impl DesktopView {
    fn new(cx: &mut Context<Self>) -> Self {
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
                self.state = Some(*state);
                self.connection = ConnectionStatus::Ready;
            }
            SidecarEvent::Frame(Frame::Error { code, message, .. }) => {
                self.connection = ConnectionStatus::Failed(format!("{code}: {message}"));
            }
            SidecarEvent::Frame(Frame::Stopped { .. }) => {
                self.connection = ConnectionStatus::Stopped;
            }
            SidecarEvent::Disconnected(message) => {
                self.connection = ConnectionStatus::Failed(message);
            }
        }
    }

    fn send(&mut self, command: DesktopCommand) {
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

    fn on_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if modifiers.platform && key == "r" {
            self.send(DesktopCommand::refresh_fleet());
        } else if modifiers.control && key == "c" {
            if let Some(fence) = self.selection_fence() {
                self.send(DesktopCommand::abort(fence));
            }
        } else if key == "escape" {
            self.send(DesktopCommand::close());
        } else if key == "enter" {
            if modifiers.shift {
                self.draft.push('\n');
                self.sync_draft();
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
                        let active = selected == Some(session.id.as_str());
                        let usable = session.usable();
                        let status_color = match session.agent_state.as_deref() {
                            Some("waiting") => theme.warning,
                            Some("working") => theme.accent,
                            _ if !usable => theme.text_faint,
                            _ => theme.text_muted,
                        };
                        div()
                            .id(SharedString::from(format!("session-{id}")))
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
                            .when(usable, |row| {
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
                                                    .text_color(if usable {
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
                                                    .child(SharedString::from(
                                                        session.updated_at.clone(),
                                                    )),
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
                            .id("refresh-fleet")
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
                            .child("REFRESH"),
                    ),
            )
            .child(
                div()
                    .id("fleet-scroll")
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

    fn render_main(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        let selected_id = self
            .state
            .as_ref()
            .and_then(|state| state.selected_session_id.as_deref());
        let selected_row = selected_id.and_then(|id| {
            self.state
                .as_ref()?
                .fleet
                .iter()
                .find(|session| session.id == id)
        });
        let selected = self
            .state
            .as_ref()
            .and_then(|state| state.selected.as_ref());
        let title = selected_row
            .map(|session| session.title.clone())
            .unwrap_or_else(|| "Choose a session".into());
        let subtitle = selected_row
            .map(|session| format!("{} · {}", session.repo, session.branch))
            .unwrap_or_else(|| {
                "Every warm session remains active while you move between them.".into()
            });
        let transcript = selected
            .and_then(|selected| selected.live.as_ref())
            .map(|live| {
                live.transcript
                    .iter()
                    .enumerate()
                    .map(|(index, item)| render_transcript_item(index, item, &theme))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
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
        let error = self
            .state
            .as_ref()
            .and_then(|state| state.fleet_error.as_deref())
            .or_else(|| selected.and_then(|selected| selected.error.as_deref()))
            .or_else(|| {
                selected
                    .and_then(|selected| selected.unavailable.as_ref())
                    .map(|unavailable| unavailable.reason.as_str())
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
                    .h(px(62.0))
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
                            ),
                    )
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
                    ),
            )
            .child(
                div()
                    .id("transcript-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .py(px(26.0))
                    .children(transcript)
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
                                                .child("Select a warm session. Scotty changes only the view; the remote Pi process keeps running."),
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
        let enabled = selected_session_id.is_some();
        let abort_fence = make_selection_fence(selected_session_id, selected);
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
                            .min_h(px(20.0))
                            .text_size(px(13.0))
                            .text_color(if self.draft.is_empty() {
                                theme.text_faint
                            } else {
                                theme.text
                            })
                            .child(SharedString::from(if !enabled {
                                "Select a warm session".into()
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
        div()
            .id("scotty-desktop-root")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key_down))
            .size_full()
            .flex()
            .flex_row()
            .bg(theme.glass())
            .text_color(theme.text)
            .font_family(theme.font_sans)
            .text_size(px(14.0))
            .child(self.render_sidebar(cx))
            .child(self.render_main(cx))
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

fn should_apply_draft(selection_changed: bool, incoming: u64, current: u64) -> bool {
    selection_changed || incoming > current
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

fn render_transcript_item(index: usize, item: &TranscriptItem, theme: &Theme) -> gpui::AnyElement {
    let row = div()
        .id(SharedString::from(format!(
            "transcript-{index}-{}",
            item.id()
        )))
        .w_full()
        .px(px(48.0))
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
            .child(
                column.child(
                    div()
                        .px(px(2.0))
                        .text_size(px(13.0))
                        .text_color(theme.text)
                        .child(SharedString::from(truncate(text, 16_000))),
                ),
            )
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
                                .child(SharedString::from(truncate(text, 8_000))),
                        ),
                ),
            )
            .into_any_element(),
        TranscriptItem::Tool {
            name,
            summary,
            detail,
            status,
            result,
            ..
        } => row
            .mb(px(8.0))
            .child(column.child(render_tool(
                name,
                summary,
                detail.as_deref(),
                *status,
                result.as_deref(),
                theme,
            )))
            .into_any_element(),
        TranscriptItem::Error { message, .. } => row
            .mb(px(10.0))
            .child(column.child(render_error(message, theme)))
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

fn render_tool(
    name: &str,
    summary: &str,
    detail: Option<&str>,
    status: ToolStatus,
    result: Option<&str>,
    theme: &Theme,
) -> gpui::AnyElement {
    let (glyph, status_label, tint) = match status {
        ToolStatus::Pending => ("○", "PENDING", theme.text_faint),
        ToolStatus::Running => ("●", "RUNNING", theme.accent),
        ToolStatus::Completed => ("✓", "DONE", theme.text_muted),
        ToolStatus::Failed => ("!", "FAILED", theme.danger),
    };
    let preview = result
        .map(|value| single_line(value, 180))
        .filter(|value| !value.is_empty());
    div()
        .flex()
        .items_stretch()
        .child(div().ml(px(12.0)).w(px(1.0)).flex_none().bg(theme.border))
        .child(
            div()
                .ml(px(12.0))
                .min_w_0()
                .flex_1()
                .flex()
                .items_center()
                .gap(px(9.0))
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
                .px(px(9.0))
                .py(px(8.0))
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
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(7.0))
                                .child(
                                    div()
                                        .text_size(px(12.0))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(if status == ToolStatus::Failed {
                                            theme.danger
                                        } else {
                                            theme.text
                                        })
                                        .child(SharedString::from(summary.to_string())),
                                )
                                .child(
                                    div()
                                        .text_size(px(8.5))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(tint)
                                        .child(status_label),
                                )
                                .child(
                                    div()
                                        .text_size(px(9.0))
                                        .text_color(theme.text_faint)
                                        .child(SharedString::from(name.to_string())),
                                ),
                        )
                        .when_some(detail, |content, detail| {
                            content.child(
                                div()
                                    .mt(px(2.0))
                                    .truncate()
                                    .font_family(theme.font_mono.clone())
                                    .text_size(px(10.5))
                                    .text_color(theme.text_muted)
                                    .child(SharedString::from(single_line(detail, 220))),
                            )
                        })
                        .when_some(preview, |content, preview| {
                            content.child(
                                div()
                                    .mt(px(2.0))
                                    .truncate()
                                    .font_family(theme.font_mono.clone())
                                    .text_size(px(10.0))
                                    .text_color(if status == ToolStatus::Failed {
                                        theme.danger.opacity(0.85)
                                    } else {
                                        theme.text_faint
                                    })
                                    .child(SharedString::from(preview)),
                            )
                        }),
                ),
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
    use super::should_apply_draft;

    #[test]
    fn stale_draft_frames_cannot_replace_local_edits() {
        assert!(!should_apply_draft(false, 4, 5));
        assert!(!should_apply_draft(false, 5, 5));
        assert!(should_apply_draft(false, 6, 5));
        assert!(should_apply_draft(true, 0, 5));
    }
}
