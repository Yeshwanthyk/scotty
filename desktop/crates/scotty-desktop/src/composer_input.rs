//! Native multiline composer input.
//!
//! Adapted from Comet's GPUI `ComposerInput`, itself adapted from GPUI's
//! `examples/input.rs`. This module owns text editing only; Scotty's sidecar
//! remains authoritative for drafts, command fencing, and delivery.

use std::ops::Range;
use std::time::{Duration, Instant};

use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, DispatchPhase, ElementInputHandler, Entity,
    EntityInputHandler, EventEmitter, FocusHandle, Focusable, GlobalElementId, KeyBinding,
    LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point,
    ScrollWheelEvent, SharedString, Style, Task, TextRun, TextStyle, UTF16Selection,
    UnderlineStyle, Window, WrappedLine, actions, div, fill, point, prelude::*, px, relative, size,
};
use unicode_segmentation::UnicodeSegmentation;

use crate::theme::Theme;

const DEFAULT_INPUT_LINE_HEIGHT: f32 = 20.0;
const INPUT_MAX_HEIGHT: f32 = 120.0;
const CARET_BLINK_MS: u64 = 500;
const DRAG_SCROLL_FRAME_MS: u64 = 16;

fn caret_visible(ms_since_activity: u64) -> bool {
    (ms_since_activity / CARET_BLINK_MS).is_multiple_of(2)
}

fn max_scroll(content_height: f32, viewport_height: f32) -> f32 {
    (content_height - viewport_height).max(0.0)
}

fn scroll_offset(current: f32, delta_y: f32, content_height: f32, viewport_height: f32) -> f32 {
    (current - delta_y).clamp(0.0, max_scroll(content_height, viewport_height))
}

fn reveal_cursor(
    current: f32,
    cursor_top: f32,
    cursor_height: f32,
    content_height: f32,
    viewport_height: f32,
) -> f32 {
    let mut next = current;
    if cursor_top < next {
        next = cursor_top;
    } else if cursor_top + cursor_height > next + viewport_height {
        next = cursor_top + cursor_height - viewport_height;
    }
    next.clamp(0.0, max_scroll(content_height, viewport_height))
}

fn utf8_offset_from_utf16(text: &str, offset: usize) -> usize {
    let mut utf8 = 0;
    let mut utf16 = 0;
    for character in text.chars() {
        if utf16 >= offset {
            break;
        }
        utf16 += character.len_utf16();
        utf8 += character.len_utf8();
    }
    utf8
}

fn drag_scroll_delta(
    pointer_y: f32,
    viewport_top: f32,
    viewport_bottom: f32,
    line_height: f32,
) -> f32 {
    let distance = if pointer_y < viewport_top {
        pointer_y - viewport_top
    } else if pointer_y > viewport_bottom {
        pointer_y - viewport_bottom
    } else {
        return 0.0;
    };
    distance.signum() * (distance.abs() * 0.2).clamp(1.0, line_height)
}

actions!(
    scotty_composer,
    [
        Backspace,
        Delete,
        Left,
        Right,
        Up,
        Down,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        SelectAll,
        Home,
        End,
        SelectHome,
        SelectEnd,
        DocStart,
        DocEnd,
        SelectDocStart,
        SelectDocEnd,
        WordLeft,
        WordRight,
        SelectWordLeft,
        SelectWordRight,
        DeleteWordLeft,
        DeleteWordRight,
        DeleteToLineStart,
        DeleteToLineEnd,
        Copy,
        Cut,
        Paste,
        Newline,
        Submit,
        SubmitFollowUp,
        Undo,
        Redo,
    ]
);

const UNDO_COALESCE: Duration = Duration::from_millis(700);
const UNDO_LIMIT: usize = 200;

#[derive(Clone)]
struct EditSnapshot {
    content: String,
    selected_range: Range<usize>,
    selection_reversed: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EditKind {
    Insert,
    Delete,
}

fn text_edit_bindings(context: &'static str) -> Vec<KeyBinding> {
    let context = Some(context);
    let mut bindings = vec![
        KeyBinding::new("backspace", Backspace, context),
        KeyBinding::new("delete", Delete, context),
        KeyBinding::new("left", Left, context),
        KeyBinding::new("right", Right, context),
        KeyBinding::new("up", Up, context),
        KeyBinding::new("down", Down, context),
        KeyBinding::new("shift-left", SelectLeft, context),
        KeyBinding::new("shift-right", SelectRight, context),
        KeyBinding::new("shift-up", SelectUp, context),
        KeyBinding::new("shift-down", SelectDown, context),
        KeyBinding::new("home", Home, context),
        KeyBinding::new("end", End, context),
        KeyBinding::new("shift-home", SelectHome, context),
        KeyBinding::new("shift-end", SelectEnd, context),
        KeyBinding::new("cmd-left", Home, context),
        KeyBinding::new("cmd-right", End, context),
        KeyBinding::new("cmd-up", DocStart, context),
        KeyBinding::new("cmd-down", DocEnd, context),
        KeyBinding::new("shift-cmd-left", SelectHome, context),
        KeyBinding::new("shift-cmd-right", SelectEnd, context),
        KeyBinding::new("shift-cmd-up", SelectDocStart, context),
        KeyBinding::new("shift-cmd-down", SelectDocEnd, context),
        KeyBinding::new("cmd-backspace", DeleteToLineStart, context),
        KeyBinding::new("cmd-delete", DeleteToLineEnd, context),
    ];
    let word_prefix = if cfg!(target_os = "macos") {
        "alt"
    } else {
        "ctrl"
    };
    bindings.push(KeyBinding::new(
        &format!("{word_prefix}-left"),
        WordLeft,
        context,
    ));
    bindings.push(KeyBinding::new(
        &format!("{word_prefix}-right"),
        WordRight,
        context,
    ));
    bindings.push(KeyBinding::new(
        &format!("shift-{word_prefix}-left"),
        SelectWordLeft,
        context,
    ));
    bindings.push(KeyBinding::new(
        &format!("shift-{word_prefix}-right"),
        SelectWordRight,
        context,
    ));
    bindings.push(KeyBinding::new(
        &format!("{word_prefix}-backspace"),
        DeleteWordLeft,
        context,
    ));
    bindings.push(KeyBinding::new(
        &format!("{word_prefix}-delete"),
        DeleteWordRight,
        context,
    ));
    for prefix in ["cmd", "ctrl"] {
        bindings.push(KeyBinding::new(&format!("{prefix}-a"), SelectAll, context));
        bindings.push(KeyBinding::new(&format!("{prefix}-c"), Copy, context));
        bindings.push(KeyBinding::new(&format!("{prefix}-x"), Cut, context));
        bindings.push(KeyBinding::new(&format!("{prefix}-v"), Paste, context));
        bindings.push(KeyBinding::new(&format!("{prefix}-z"), Undo, context));
        bindings.push(KeyBinding::new(&format!("shift-{prefix}-z"), Redo, context));
    }
    bindings
}

pub fn init(cx: &mut App) {
    let context = Some("ScottyComposer");
    let mut composer_bindings = text_edit_bindings("ScottyComposer");
    composer_bindings.extend([
        KeyBinding::new("enter", Submit, context),
        KeyBinding::new("alt-enter", SubmitFollowUp, context),
        KeyBinding::new("shift-enter", Newline, context),
    ]);
    cx.bind_keys(composer_bindings);
    // Management forms reuse native editing but reserve Enter and Tab for
    // panel navigation, multiline prompts, and submission in DesktopView.
    cx.bind_keys(text_edit_bindings("ScottyManagementInput"));
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, Some("PaletteSearch")),
        KeyBinding::new("delete", Delete, Some("PaletteSearch")),
        KeyBinding::new("cmd-a", SelectAll, Some("PaletteSearch")),
        KeyBinding::new("ctrl-a", SelectAll, Some("PaletteSearch")),
        KeyBinding::new("cmd-c", Copy, Some("PaletteSearch")),
        KeyBinding::new("ctrl-c", Copy, Some("PaletteSearch")),
        KeyBinding::new("cmd-x", Cut, Some("PaletteSearch")),
        KeyBinding::new("ctrl-x", Cut, Some("PaletteSearch")),
        KeyBinding::new("cmd-v", Paste, Some("PaletteSearch")),
        KeyBinding::new("ctrl-v", Paste, Some("PaletteSearch")),
        KeyBinding::new("cmd-z", Undo, Some("PaletteSearch")),
        KeyBinding::new("ctrl-z", Undo, Some("PaletteSearch")),
        KeyBinding::new("shift-cmd-z", Redo, Some("PaletteSearch")),
        KeyBinding::new("shift-ctrl-z", Redo, Some("PaletteSearch")),
    ]);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerInputEvent {
    Edited,
    Submitted { force_follow_up: bool },
}

pub struct ComposerInput {
    focus_handle: FocusHandle,
    content: String,
    placeholder: SharedString,
    aria_label: SharedString,
    key_context: &'static str,
    selected_range: Range<usize>,
    selection_reversed: bool,
    marked_range: Option<Range<usize>>,
    max_bytes: usize,
    editable: bool,
    is_selecting: bool,
    drag_position: Option<Point<Pixels>>,
    drag_generation: u64,
    drag_autoscroll_active: bool,
    scroll_top: f32,
    follow_cursor: bool,
    last_lines: Vec<WrappedLine>,
    line_starts: Vec<usize>,
    last_bounds: Option<Bounds<Pixels>>,
    line_height: Pixels,
    content_height: f32,
    display_is_placeholder: bool,
    blink_anchor: Instant,
    blink_task: Option<Task<()>>,
    undo_stack: Vec<EditSnapshot>,
    redo_stack: Vec<EditSnapshot>,
    last_edit: Option<(EditKind, usize, Instant)>,
}

impl ComposerInput {
    pub fn new(
        placeholder: impl Into<SharedString>,
        max_bytes: usize,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            content: String::new(),
            placeholder: placeholder.into(),
            aria_label: "Message selected sandbox".into(),
            key_context: "ScottyComposer",
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            max_bytes,
            editable: false,
            is_selecting: false,
            drag_position: None,
            drag_generation: 0,
            drag_autoscroll_active: false,
            scroll_top: 0.0,
            follow_cursor: true,
            last_lines: Vec::new(),
            line_starts: vec![0],
            last_bounds: None,
            line_height: px(DEFAULT_INPUT_LINE_HEIGHT),
            content_height: DEFAULT_INPUT_LINE_HEIGHT,
            display_is_placeholder: true,
            blink_anchor: Instant::now(),
            blink_task: None,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            last_edit: None,
        }
    }

    pub fn text(&self) -> &str {
        &self.content
    }

    pub fn with_context_and_label(
        mut self,
        key_context: &'static str,
        aria_label: impl Into<SharedString>,
    ) -> Self {
        self.key_context = key_context;
        self.aria_label = aria_label.into();
        self
    }

    pub fn replace_document(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        let text = text.into();
        let end = text.floor_char_boundary(text.len().min(self.max_bytes));
        self.content = text[..end].to_string();
        let cursor = self.content.len();
        self.selected_range = cursor..cursor;
        self.selection_reversed = false;
        self.marked_range = None;
        self.scroll_top = 0.0;
        self.follow_cursor = true;
        // Sidecar draft hydration and clear-on-submit replace the document;
        // undo must never cross that authoritative boundary.
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.last_edit = None;
        self.reset_blink();
        cx.notify();
    }

    fn snapshot(&self) -> EditSnapshot {
        EditSnapshot {
            content: self.content.clone(),
            selected_range: self.selected_range.clone(),
            selection_reversed: self.selection_reversed,
        }
    }

    fn record_edit(&mut self, range: &Range<usize>, new_text: &str) {
        let kind = if new_text.is_empty() {
            EditKind::Delete
        } else {
            EditKind::Insert
        };
        let mergeable = match (kind, &self.last_edit) {
            (EditKind::Insert, Some((EditKind::Insert, at, when))) => {
                range.is_empty()
                    && range.start == *at
                    && new_text.chars().count() == 1
                    && !new_text.starts_with(['\n', ' ', '\t'])
                    && when.elapsed() < UNDO_COALESCE
            }
            (EditKind::Delete, Some((EditKind::Delete, at, when))) => {
                range.end == *at && when.elapsed() < UNDO_COALESCE
            }
            _ => false,
        };
        if !mergeable {
            self.undo_stack.push(self.snapshot());
            if self.undo_stack.len() > UNDO_LIMIT {
                self.undo_stack.remove(0);
            }
        }
        self.redo_stack.clear();
        let tail = match kind {
            EditKind::Insert => range.start + new_text.len(),
            EditKind::Delete => range.start,
        };
        self.last_edit = Some((kind, tail, Instant::now()));
    }

    fn restore(&mut self, snapshot: EditSnapshot, cx: &mut Context<Self>) {
        self.content = snapshot.content;
        self.selected_range = snapshot.selected_range;
        self.selection_reversed = snapshot.selection_reversed;
        self.marked_range = None;
        self.follow_cursor = true;
        self.last_edit = None;
        self.reset_blink();
        cx.emit(ComposerInputEvent::Edited);
        cx.notify();
    }

    fn undo(&mut self, _: &Undo, _: &mut Window, cx: &mut Context<Self>) {
        let Some(previous) = self.undo_stack.pop() else {
            return;
        };
        let current = self.snapshot();
        self.redo_stack.push(current);
        self.restore(previous, cx);
    }

    fn redo(&mut self, _: &Redo, _: &mut Window, cx: &mut Context<Self>) {
        let Some(next) = self.redo_stack.pop() else {
            return;
        };
        let current = self.snapshot();
        self.undo_stack.push(current);
        self.restore(next, cx);
    }

    pub fn set_editable(&mut self, editable: bool, cx: &mut Context<Self>) {
        if self.editable == editable {
            return;
        }
        self.editable = editable;
        if !editable {
            self.marked_range = None;
            self.is_selecting = false;
            self.blink_task = None;
        }
        cx.notify();
    }

    pub fn has_selection(&self) -> bool {
        !self.selected_range.is_empty()
    }

    pub fn insert_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.replace_selection(text, cx);
    }

    fn reset_blink(&mut self) {
        self.blink_anchor = Instant::now();
    }

    fn caret_shown(&mut self, window: &Window, cx: &mut Context<Self>) -> bool {
        if !self.editable || !self.focus_handle.is_focused(window) || !window.is_window_active() {
            self.blink_task = None;
            return false;
        }
        if self.blink_task.is_none() {
            self.blink_task = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor()
                        .timer(Duration::from_millis(CARET_BLINK_MS))
                        .await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        break;
                    }
                }
            }));
        }
        caret_visible(self.blink_anchor.elapsed().as_millis() as u64)
    }

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed {
            self.selected_range.start
        } else {
            self.selected_range.end
        }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = offset.min(self.content.len());
        self.selected_range = offset..offset;
        self.selection_reversed = false;
        self.follow_cursor = true;
        self.reset_blink();
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = offset.min(self.content.len());
        if self.selection_reversed {
            self.selected_range.start = offset;
        } else {
            self.selected_range.end = offset;
        }
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        self.follow_cursor = true;
        self.reset_blink();
        cx.notify();
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .rev()
            .find_map(|(index, _)| (index < offset).then_some(index))
            .unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .find_map(|(index, _)| (index > offset).then_some(index))
            .unwrap_or(self.content.len())
    }

    fn previous_word_boundary(&self, offset: usize) -> usize {
        self.content
            .split_word_bound_indices()
            .rev()
            .find_map(|(index, word)| (index < offset && !word.trim().is_empty()).then_some(index))
            .unwrap_or(0)
    }

    fn next_word_boundary(&self, offset: usize) -> usize {
        self.content
            .split_word_bound_indices()
            .find_map(|(index, word)| {
                let end = index + word.len();
                (end > offset && !word.trim().is_empty()).then_some(end)
            })
            .unwrap_or(self.content.len())
    }

    fn line_range_at(&self, offset: usize) -> Range<usize> {
        let start = self.content[..offset]
            .rfind('\n')
            .map(|index| index + 1)
            .unwrap_or(0);
        let end = self.content[offset..]
            .find('\n')
            .map(|index| offset + index)
            .unwrap_or(self.content.len());
        start..end
    }

    fn replace_selection(&mut self, new_text: &str, cx: &mut Context<Self>) {
        if !self.editable {
            return;
        }
        let range = self
            .marked_range
            .clone()
            .unwrap_or(self.selected_range.clone());
        let retained = self.content.len().saturating_sub(range.len());
        let available = self.max_bytes.saturating_sub(retained);
        let end = new_text.floor_char_boundary(new_text.len().min(available));
        let replacement = &new_text[..end];
        if range.is_empty() && replacement.is_empty() {
            return;
        }
        if self.marked_range.is_none() {
            self.record_edit(&range, replacement);
        }
        self.content.replace_range(range.clone(), replacement);
        let cursor = range.start + replacement.len();
        self.selected_range = cursor..cursor;
        self.selection_reversed = false;
        self.marked_range = None;
        self.follow_cursor = true;
        self.reset_blink();
        cx.emit(ComposerInputEvent::Edited);
        cx.notify();
    }

    fn backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let previous = self.previous_boundary(self.cursor_offset());
            if previous == self.cursor_offset() {
                return;
            }
            self.select_to(previous, cx);
        }
        self.replace_selection("", cx);
    }

    fn delete(&mut self, _: &Delete, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let next = self.next_boundary(self.cursor_offset());
            if next == self.cursor_offset() {
                return;
            }
            self.select_to(next, cx);
        }
        self.replace_selection("", cx);
    }

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.previous_boundary(self.cursor_offset()), cx);
        } else {
            self.move_to(self.selected_range.start, cx);
        }
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.next_boundary(self.cursor_offset()), cx);
        } else {
            self.move_to(self.selected_range.end, cx);
        }
    }

    fn vertical_target(&self, direction: f32) -> Option<usize> {
        let current = self.point_for_index(self.cursor_offset())?;
        let target_y = f32::from(current.y) + direction * f32::from(self.line_height);
        if target_y < 0.0 {
            return Some(0);
        }
        if target_y >= self.content_height {
            return Some(self.content.len());
        }
        Some(self.index_for_point(point(current.x, px(target_y))))
    }

    fn up(&mut self, _: &Up, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(index) = self.vertical_target(-1.0) {
            self.move_to(index, cx);
        }
    }

    fn down(&mut self, _: &Down, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(index) = self.vertical_target(1.0) {
            self.move_to(index, cx);
        }
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor_offset()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor_offset()), cx);
    }

    fn select_up(&mut self, _: &SelectUp, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(index) = self.vertical_target(-1.0) {
            self.select_to(index, cx);
        }
    }

    fn select_down(&mut self, _: &SelectDown, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(index) = self.vertical_target(1.0) {
            self.select_to(index, cx);
        }
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
        self.select_to(self.content.len(), cx);
    }

    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.line_range_at(self.cursor_offset()).start, cx);
    }

    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.line_range_at(self.cursor_offset()).end, cx);
    }

    fn select_home(&mut self, _: &SelectHome, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.line_range_at(self.cursor_offset()).start, cx);
    }

    fn select_end(&mut self, _: &SelectEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.line_range_at(self.cursor_offset()).end, cx);
    }

    fn doc_start(&mut self, _: &DocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
    }

    fn doc_end(&mut self, _: &DocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.content.len(), cx);
    }

    fn select_doc_start(&mut self, _: &SelectDocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(0, cx);
    }

    fn select_doc_end(&mut self, _: &SelectDocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.content.len(), cx);
    }

    fn word_left(&mut self, _: &WordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.previous_word_boundary(self.cursor_offset()), cx);
    }

    fn word_right(&mut self, _: &WordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.next_word_boundary(self.cursor_offset()), cx);
    }

    fn select_word_left(&mut self, _: &SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_word_boundary(self.cursor_offset()), cx);
    }

    fn select_word_right(&mut self, _: &SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_word_boundary(self.cursor_offset()), cx);
    }

    fn delete_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            if self.cursor_offset() == offset {
                return;
            }
            self.select_to(offset, cx);
        }
        self.replace_selection("", cx);
    }

    fn delete_word_left(&mut self, _: &DeleteWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.delete_to(self.previous_word_boundary(self.cursor_offset()), cx);
    }

    fn delete_word_right(&mut self, _: &DeleteWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.delete_to(self.next_word_boundary(self.cursor_offset()), cx);
    }

    fn delete_to_line_start(
        &mut self,
        _: &DeleteToLineStart,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.delete_to(self.line_range_at(self.cursor_offset()).start, cx);
    }

    fn delete_to_line_end(&mut self, _: &DeleteToLineEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.delete_to(self.line_range_at(self.cursor_offset()).end, cx);
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
        } else if let Some(text) = crate::transcript_selection::selected_text() {
            // The composer keeps focus while the user reads the transcript.
            // Match Comet: Cmd/Ctrl+C with no draft selection copies the
            // settled rendered-text selection instead.
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    fn cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
            self.replace_selection("", cx);
        }
    }

    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.replace_selection(&text, cx);
        }
    }

    fn newline(&mut self, _: &Newline, _: &mut Window, cx: &mut Context<Self>) {
        self.replace_selection("\n", cx);
    }

    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        if !self.editable {
            return;
        }
        cx.emit(ComposerInputEvent::Submitted {
            force_follow_up: false,
        });
    }

    fn submit_follow_up(&mut self, _: &SubmitFollowUp, _: &mut Window, cx: &mut Context<Self>) {
        if !self.editable {
            return;
        }
        cx.emit(ComposerInputEvent::Submitted {
            force_follow_up: true,
        });
    }

    fn point_for_index(&self, index: usize) -> Option<Point<Pixels>> {
        for (line_index, line) in self.last_lines.iter().enumerate() {
            let line_start = *self.line_starts.get(line_index)?;
            if index < line_start {
                continue;
            }
            if index <= line_start + line.len() {
                let local = line.position_for_index(index - line_start, self.line_height)?;
                let y: f32 = self
                    .last_lines
                    .iter()
                    .take(line_index)
                    .map(|line| f32::from(line.size(self.line_height).height))
                    .sum();
                return Some(point(local.x, local.y + px(y)));
            }
        }
        None
    }

    fn index_for_point(&self, position: Point<Pixels>) -> usize {
        if self.display_is_placeholder {
            return 0;
        }
        let mut y = f32::from(position.y);
        if y < 0.0 {
            return 0;
        }
        for (line_index, line) in self.last_lines.iter().enumerate() {
            let height = f32::from(line.size(self.line_height).height);
            let line_start = self.line_starts.get(line_index).copied().unwrap_or(0);
            if y < height || line_index + 1 == self.last_lines.len() {
                let local = point(position.x, px(y.min(height - 1.0).max(0.0)));
                let index = line
                    .closest_index_for_position(local, self.line_height)
                    .unwrap_or_else(|index| index);
                return (line_start + index).min(self.content.len());
            }
            y -= height;
        }
        self.content.len()
    }

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        let Some(bounds) = self.last_bounds else {
            return 0;
        };
        self.index_for_point(point(
            position.x - bounds.left(),
            position.y - bounds.top() + px(self.scroll_top),
        ))
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus_handle, cx);
        if !self.editable {
            return;
        }
        self.is_selecting = true;
        self.drag_position = Some(event.position);
        self.drag_generation = self.drag_generation.wrapping_add(1);
        self.drag_autoscroll_active = false;
        let index = self.index_for_mouse_position(event.position);
        if event.modifiers.shift {
            self.select_to(index, cx);
        } else {
            self.move_to(index, cx);
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
        self.drag_position = None;
        self.drag_generation = self.drag_generation.wrapping_add(1);
        self.drag_autoscroll_active = false;
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        if !self.is_selecting {
            return;
        }
        self.drag_position = Some(event.position);
        let position = self.drag_selection_position(event.position);
        self.select_to(self.index_for_mouse_position(position), cx);
        if self.drag_delta(event.position) != 0.0 && !self.drag_autoscroll_active {
            self.start_drag_autoscroll(cx);
        }
    }

    fn drag_selection_position(&self, position: Point<Pixels>) -> Point<Pixels> {
        let Some(bounds) = self.last_bounds else {
            return position;
        };
        point(
            position.x.clamp(bounds.left(), bounds.right() - px(0.5)),
            position.y.clamp(bounds.top(), bounds.bottom() - px(0.5)),
        )
    }

    fn drag_delta(&self, position: Point<Pixels>) -> f32 {
        let Some(bounds) = self.last_bounds else {
            return 0.0;
        };
        drag_scroll_delta(
            f32::from(position.y),
            f32::from(bounds.top()),
            f32::from(bounds.bottom()),
            f32::from(self.line_height),
        )
    }

    fn start_drag_autoscroll(&mut self, cx: &mut Context<Self>) {
        self.drag_autoscroll_active = true;
        let generation = self.drag_generation;
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(DRAG_SCROLL_FRAME_MS))
                    .await;
                let keep_running = this
                    .update(cx, |input, cx| input.drag_autoscroll_tick(generation, cx))
                    .unwrap_or(false);
                if !keep_running {
                    break;
                }
            }
        })
        .detach();
    }

    fn drag_autoscroll_tick(&mut self, generation: u64, cx: &mut Context<Self>) -> bool {
        if !self.is_selecting || self.drag_generation != generation {
            return false;
        }
        let (Some(position), Some(bounds)) = (self.drag_position, self.last_bounds) else {
            self.drag_autoscroll_active = false;
            return false;
        };
        let delta = self.drag_delta(position);
        if delta == 0.0 {
            self.drag_autoscroll_active = false;
            return false;
        }
        let next = (self.scroll_top + delta).clamp(
            0.0,
            max_scroll(self.content_height, f32::from(bounds.size.height)),
        );
        if next == self.scroll_top {
            self.drag_autoscroll_active = false;
            return false;
        }
        self.scroll_top = next;
        let edge = self.drag_selection_position(position);
        self.select_to(self.index_for_mouse_position(edge), cx);
        self.follow_cursor = false;
        true
    }

    fn on_scroll_wheel(
        &mut self,
        event: &ScrollWheelEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(bounds) = self.last_bounds else {
            return;
        };
        let next = scroll_offset(
            self.scroll_top,
            f32::from(event.delta.pixel_delta(self.line_height).y),
            self.content_height,
            f32::from(bounds.size.height),
        );
        if next == self.scroll_top {
            return;
        }
        self.scroll_top = next;
        self.follow_cursor = false;
        cx.stop_propagation();
        cx.notify();
    }

    fn offset_from_utf16(&self, offset: usize) -> usize {
        utf8_offset_from_utf16(&self.content, offset)
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let mut utf8 = 0;
        let mut utf16 = 0;
        for character in self.content.chars() {
            if utf8 >= offset {
                break;
            }
            utf8 += character.len_utf8();
            utf16 += character.len_utf16();
        }
        utf16
    }

    fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range.start)..self.offset_from_utf16(range.end)
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn layout_text(&mut self, width: Pixels, style: &TextStyle, window: &mut Window) -> f32 {
        let (display, placeholder) = if self.content.is_empty() {
            (self.placeholder.clone(), true)
        } else {
            (SharedString::from(self.content.clone()), false)
        };
        let font_size = style.font_size.to_pixels(window.rem_size());
        self.line_height = style.line_height_in_pixels(window.rem_size());
        let run = |len: usize, underline: bool| TextRun {
            len,
            font: style.font(),
            color: style.color,
            background_color: None,
            underline: underline.then_some(UnderlineStyle {
                color: Some(style.color),
                thickness: px(1.0),
                wavy: false,
            }),
            strikethrough: None,
        };
        let runs: Vec<TextRun> = match self.marked_range.as_ref() {
            Some(marked) if !placeholder => vec![
                run(marked.start, false),
                run(marked.len(), true),
                run(display.len() - marked.end, false),
            ]
            .into_iter()
            .filter(|run| run.len > 0)
            .collect(),
            _ => vec![run(display.len(), false)],
        };
        let lines = window
            .text_system()
            .shape_text(display, font_size, &runs, Some(width), None)
            .map(|lines| lines.into_vec())
            .unwrap_or_default();
        let mut starts = Vec::with_capacity(lines.len());
        let mut offset = 0;
        for line in &lines {
            starts.push(offset);
            offset += line.len() + 1;
        }
        if starts.is_empty() {
            starts.push(0);
        }
        self.content_height = lines
            .iter()
            .map(|line| f32::from(line.size(self.line_height).height))
            .sum::<f32>()
            .max(f32::from(self.line_height));
        self.display_is_placeholder = placeholder;
        self.last_lines = lines;
        self.line_starts = starts;
        self.content_height
    }

    fn clamp_scroll(&mut self, viewport_height: f32) {
        if self.follow_cursor
            && let Some(cursor) = self.point_for_index(self.cursor_offset())
        {
            self.scroll_top = reveal_cursor(
                self.scroll_top,
                f32::from(cursor.y),
                f32::from(self.line_height),
                self.content_height,
                viewport_height,
            );
        }
        self.scroll_top = self
            .scroll_top
            .clamp(0.0, max_scroll(self.content_height, viewport_height));
    }
}

impl EventEmitter<ComposerInputEvent> for ComposerInput {}

impl Focusable for ComposerInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl EntityInputHandler for ComposerInput {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content.get(range)?.to_string())
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected_range),
            reversed: self.selection_reversed,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked_range
            .as_ref()
            .map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked_range = None;
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.editable {
            return;
        }
        let range = range_utf16
            .as_ref()
            .map(|range| self.range_from_utf16(range))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        let retained = self.content.len().saturating_sub(range.len());
        let available = self.max_bytes.saturating_sub(retained);
        let end = new_text.floor_char_boundary(new_text.len().min(available));
        let replacement = &new_text[..end];
        if range.is_empty() && replacement.is_empty() {
            return;
        }
        // The first marked-text update already captured the pre-composition
        // state, so committing that composition must not add a second step.
        if self.marked_range.is_none() {
            self.record_edit(&range, replacement);
        }
        self.content.replace_range(range.clone(), replacement);
        let cursor = range.start + replacement.len();
        self.selected_range = cursor..cursor;
        self.selection_reversed = false;
        self.marked_range = None;
        self.follow_cursor = true;
        self.reset_blink();
        cx.emit(ComposerInputEvent::Edited);
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.editable {
            return;
        }
        let range = range_utf16
            .as_ref()
            .map(|range| self.range_from_utf16(range))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        let retained = self.content.len().saturating_sub(range.len());
        let available = self.max_bytes.saturating_sub(retained);
        let end = new_text.floor_char_boundary(new_text.len().min(available));
        let replacement = &new_text[..end];
        if self.marked_range.is_none() {
            self.undo_stack.push(self.snapshot());
            if self.undo_stack.len() > UNDO_LIMIT {
                self.undo_stack.remove(0);
            }
            self.redo_stack.clear();
            self.last_edit = None;
        }
        self.content.replace_range(range.clone(), replacement);
        self.marked_range =
            (!replacement.is_empty()).then_some(range.start..range.start + replacement.len());
        self.selected_range = new_selected_range_utf16
            .as_ref()
            .map(|selected| {
                utf8_offset_from_utf16(replacement, selected.start)
                    ..utf8_offset_from_utf16(replacement, selected.end)
            })
            .map(|selected| range.start + selected.start..range.start + selected.end)
            .unwrap_or_else(|| range.start + replacement.len()..range.start + replacement.len());
        self.selection_reversed = false;
        self.follow_cursor = true;
        self.reset_blink();
        cx.emit(ComposerInputEvent::Edited);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let range = self.range_from_utf16(&range_utf16);
        let start = self.point_for_index(range.start)?;
        let origin = point(
            bounds.left() + start.x,
            bounds.top() + start.y - px(self.scroll_top),
        );
        Some(Bounds::new(origin, size(px(2.0), self.line_height)))
    }

    fn character_index_for_point(
        &mut self,
        point_in_window: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.offset_to_utf16(self.index_for_mouse_position(point_in_window)))
    }

    fn accepts_text_input(&self, _: &mut Window, _: &mut Context<Self>) -> bool {
        self.editable
    }
}

struct ComposerTextElement {
    input: Entity<ComposerInput>,
}

struct ComposerTextPrepaint {
    cursor: Option<PaintQuad>,
    selection: Vec<PaintQuad>,
}

impl IntoElement for ComposerTextElement {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl gpui::Element for ComposerTextElement {
    type RequestLayoutState = ();
    type PrepaintState = ComposerTextPrepaint;

    fn id(&self) -> Option<gpui::ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        _: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.0).into();
        let input = self.input.clone();
        let text_style = window.text_style();
        let layout = window.request_measured_layout(style, move |known, available, window, cx| {
            let width = known.width.unwrap_or(match available.width {
                gpui::AvailableSpace::Definite(width) => width,
                _ => px(320.0),
            });
            let height = input.update(cx, |input, _| input.layout_text(width, &text_style, window));
            size(width, px(height.min(INPUT_MAX_HEIGHT)))
        });
        (layout, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut Window,
        cx: &mut App,
    ) -> ComposerTextPrepaint {
        self.input.update(cx, |input, _| {
            input.clamp_scroll(f32::from(bounds.size.height));
            input.last_bounds = Some(bounds);
        });
        let input = self.input.read(cx);
        let origin = point(bounds.left(), bounds.top() - px(input.scroll_top));
        let theme = Theme::of(cx);
        let mut cursor = None;
        let mut selection = Vec::new();
        if input.selected_range.is_empty() || input.display_is_placeholder {
            let caret_point = input
                .point_for_index(input.cursor_offset())
                .unwrap_or(point(px(0.0), px(0.0)));
            cursor = Some(fill(
                Bounds::new(
                    point(origin.x + caret_point.x, origin.y + caret_point.y),
                    size(px(1.5), input.line_height),
                ),
                theme.text,
            ));
        } else if let (Some(start), Some(end)) = (
            input.point_for_index(input.selected_range.start),
            input.point_for_index(input.selected_range.end),
        ) {
            let line_height = input.line_height;
            if start.y == end.y {
                selection.push(fill(
                    Bounds::from_corners(
                        point(origin.x + start.x, origin.y + start.y),
                        point(origin.x + end.x, origin.y + start.y + line_height),
                    ),
                    theme.accent.opacity(0.28),
                ));
            } else {
                selection.push(fill(
                    Bounds::from_corners(
                        point(origin.x + start.x, origin.y + start.y),
                        point(bounds.right(), origin.y + start.y + line_height),
                    ),
                    theme.accent.opacity(0.28),
                ));
                if end.y > start.y + line_height {
                    selection.push(fill(
                        Bounds::from_corners(
                            point(origin.x, origin.y + start.y + line_height),
                            point(bounds.right(), origin.y + end.y),
                        ),
                        theme.accent.opacity(0.28),
                    ));
                }
                selection.push(fill(
                    Bounds::from_corners(
                        point(origin.x, origin.y + end.y),
                        point(origin.x + end.x, origin.y + end.y + line_height),
                    ),
                    theme.accent.opacity(0.28),
                ));
            }
        }
        ComposerTextPrepaint { cursor, selection }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut ComposerTextPrepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.input.read(cx).focus_handle.clone();
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.input.clone()),
            cx,
        );
        let input = self.input.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
            if phase == DispatchPhase::Bubble {
                input.update(cx, |input, cx| input.on_mouse_move(event, cx));
            }
        });
        let (lines, line_height, scroll) = self.input.update(cx, |input, _| {
            (
                std::mem::take(&mut input.last_lines),
                input.line_height,
                input.scroll_top,
            )
        });
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            for quad in prepaint.selection.drain(..) {
                window.paint_quad(quad);
            }
            let mut y = bounds.top() - px(scroll);
            for line in &lines {
                let height = line.size(line_height).height;
                let _ = line.paint(
                    point(bounds.left(), y),
                    line_height,
                    gpui::TextAlign::Left,
                    Some(bounds),
                    window,
                    cx,
                );
                y += height;
            }
            if self
                .input
                .update(cx, |input, cx| input.caret_shown(window, cx))
                && let Some(cursor) = prepaint.cursor.take()
            {
                window.paint_quad(cursor);
            }
        });
        self.input.update(cx, |input, _| input.last_lines = lines);
    }
}

impl Render for ComposerInput {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx);
        let line_height = theme.composer_text_size + 7.0;
        div()
            .id(self.key_context)
            .key_context(self.key_context)
            .track_focus(&self.focus_handle)
            .role(gpui::Role::TextInput)
            .aria_label(self.aria_label.clone())
            .aria_value(SharedString::from(self.content.clone()))
            .aria_placeholder(self.placeholder.clone())
            .when(self.editable, |input| input.cursor(CursorStyle::IBeam))
            .w_full()
            .min_h(px(line_height))
            .text_size(px(theme.composer_text_size))
            .line_height(px(line_height))
            .font_family(theme.font_sans.clone())
            .text_color(if !self.editable || self.content.is_empty() {
                theme.text_faint
            } else {
                theme.text
            })
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::select_home))
            .on_action(cx.listener(Self::select_end))
            .on_action(cx.listener(Self::doc_start))
            .on_action(cx.listener(Self::doc_end))
            .on_action(cx.listener(Self::select_doc_start))
            .on_action(cx.listener(Self::select_doc_end))
            .on_action(cx.listener(Self::word_left))
            .on_action(cx.listener(Self::word_right))
            .on_action(cx.listener(Self::select_word_left))
            .on_action(cx.listener(Self::select_word_right))
            .on_action(cx.listener(Self::delete_word_left))
            .on_action(cx.listener(Self::delete_word_right))
            .on_action(cx.listener(Self::delete_to_line_start))
            .on_action(cx.listener(Self::delete_to_line_end))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::submit_follow_up))
            .on_action(cx.listener(Self::undo))
            .on_action(cx.listener(Self::redo))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_scroll_wheel(cx.listener(Self::on_scroll_wheel))
            .child(ComposerTextElement { input: cx.entity() })
    }
}

#[cfg(test)]
mod tests {
    use gpui::{TestAppContext, WindowHandle};

    use super::*;

    fn input_window(cx: &mut TestAppContext, max_bytes: usize) -> WindowHandle<ComposerInput> {
        cx.update(|cx| {
            init(cx);
            cx.set_global(Theme::dark());
            cx.open_window(Default::default(), |window, cx| {
                let input = cx.new(|cx| ComposerInput::new("Message", max_bytes, cx));
                window.focus(&input.read(cx).focus_handle(cx), cx);
                input
            })
            .unwrap()
        })
    }

    #[gpui::test]
    fn keyboard_select_all_replaces_the_complete_draft(cx: &mut TestAppContext) {
        let window = input_window(cx, 64);
        window
            .update(cx, |input, _, cx| {
                input.replace_document("hello world", cx);
                input.set_editable(true, cx);
            })
            .unwrap();
        cx.run_until_parked();

        cx.simulate_keystrokes(*window, "cmd-a");
        cx.simulate_input(*window, "replacement");

        window
            .update(cx, |input, _, _| {
                assert_eq!(input.text(), "replacement");
                assert_eq!(input.selected_range, 11..11);
            })
            .unwrap();
    }

    #[gpui::test]
    fn keyboard_undo_and_redo_restore_text_and_caret(cx: &mut TestAppContext) {
        let window = input_window(cx, 64);
        window
            .update(cx, |input, _, cx| input.set_editable(true, cx))
            .unwrap();
        cx.simulate_input(*window, "hello");

        cx.simulate_keystrokes(*window, "cmd-z");
        window
            .update(cx, |input, _, _| {
                assert_eq!(input.text(), "");
                assert_eq!(input.selected_range, 0..0);
            })
            .unwrap();

        cx.simulate_keystrokes(*window, "shift-cmd-z");
        window
            .update(cx, |input, _, _| {
                assert_eq!(input.text(), "hello");
                assert_eq!(input.selected_range, 5..5);
            })
            .unwrap();
    }

    #[gpui::test]
    fn authoritative_draft_replacement_clears_undo_history(cx: &mut TestAppContext) {
        let window = input_window(cx, 64);
        window
            .update(cx, |input, _, cx| input.set_editable(true, cx))
            .unwrap();
        cx.simulate_input(*window, "local");
        window
            .update(cx, |input, _, cx| input.replace_document("remote", cx))
            .unwrap();

        cx.simulate_keystrokes(*window, "cmd-z");
        window
            .update(cx, |input, _, _| assert_eq!(input.text(), "remote"))
            .unwrap();
    }

    #[gpui::test]
    fn keyboard_caret_movement_and_deletion_are_grapheme_safe(cx: &mut TestAppContext) {
        let window = input_window(cx, 64);
        window
            .update(cx, |input, _, cx| {
                input.replace_document("a👋🏽b", cx);
                input.set_editable(true, cx);
            })
            .unwrap();
        cx.run_until_parked();

        cx.simulate_keystrokes(*window, "left backspace");

        window
            .update(cx, |input, _, _| {
                assert_eq!(input.text(), "ab");
                assert_eq!(input.selected_range, 1..1);
            })
            .unwrap();
    }

    #[gpui::test]
    fn copy_falls_back_to_the_settled_transcript_selection(cx: &mut TestAppContext) {
        let _selection = crate::transcript_selection::test_lock();
        crate::transcript_selection::begin_with_span("transcript", "selected reply", 0..8);
        assert_eq!(
            crate::transcript_selection::end_drag("transcript").as_deref(),
            Some("selected")
        );

        let window = input_window(cx, 64);
        window
            .update(cx, |input, window, cx| input.copy(&Copy, window, cx))
            .unwrap();
        let copied = cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
        assert_eq!(copied.as_deref(), Some("selected"));
        assert!(crate::transcript_selection::clear_if_owner("transcript"));
    }

    #[gpui::test]
    fn disabled_input_rejects_platform_text(cx: &mut TestAppContext) {
        let window = input_window(cx, 64);
        cx.run_until_parked();

        cx.simulate_input(*window, "ignored");

        window
            .update(cx, |input, _, _| assert!(input.text().is_empty()))
            .unwrap();
    }

    #[gpui::test]
    fn controlled_draft_update_resets_the_caret_and_respects_the_utf8_limit(
        cx: &mut TestAppContext,
    ) {
        let input = cx.new(|cx| ComposerInput::new("Message", 5, cx));
        input.update(cx, |input, cx| {
            input.replace_document("abcdef", cx);
            assert_eq!(input.text(), "abcde");
            assert_eq!(input.selected_range, 5..5);

            input.move_to(0, cx);
            input.replace_document("ééé", cx);
            assert_eq!(input.text(), "éé");
            assert_eq!(input.selected_range, 4..4);
            assert!(input.text().is_char_boundary(input.text().len()));
        });
    }

    #[gpui::test]
    fn user_replacement_respects_the_utf8_limit(cx: &mut TestAppContext) {
        let input = cx.new(|cx| ComposerInput::new("Message", 5, cx));
        input.update(cx, |input, cx| {
            input.set_editable(true, cx);
            input.replace_selection("ééé", cx);
            assert_eq!(input.text(), "éé");
            assert_eq!(input.selected_range, 4..4);
        });
    }
}
