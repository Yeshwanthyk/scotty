//! Text selection state for Scotty's rendered transcript, adapted from Comet's
//! rendered-markdown selection model.
//!
//! GPUI has no built-in selection for plain text elements. The transcript is a
//! tree of text elements inside a virtualized list, so every frame the renderer
//! registers each painted text element in document order. A drag resolves
//! against that registry into per-element spans. The renderer paints each span
//! and copy joins them in order.

use std::ops::Range;
use std::sync::{Mutex, OnceLock};

/// One element's slice of the selection, in document order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
    /// Stable element key (`{session}:{row}:{element}`).
    pub key: String,
    /// Selected byte range of the element's flat text.
    pub range: Range<usize>,
    /// Full text snapshotted during the drag so copy survives virtualization.
    pub text: String,
}

#[derive(Clone, Default)]
struct TranscriptSelection {
    anchor_key: String,
    anchor_ix: usize,
    dragging: bool,
    spans: Vec<Span>,
}

fn state() -> &'static Mutex<Option<TranscriptSelection>> {
    static STATE: OnceLock<Mutex<Option<TranscriptSelection>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

/// Resolve selection spans between two element/index points.
pub fn resolve_spans(elements: &[(&str, &str)], a: (usize, usize), b: (usize, usize)) -> Vec<Span> {
    let (start, end) = if (a.0, a.1) <= (b.0, b.1) {
        (a, b)
    } else {
        (b, a)
    };
    let mut spans = Vec::new();
    for (element_ix, (key, text)) in elements.iter().enumerate().take(end.0 + 1).skip(start.0) {
        let from = if element_ix == start.0 { start.1 } else { 0 };
        let to = if element_ix == end.0 {
            end.1
        } else {
            text.len()
        };
        let (from, to) = (from.min(text.len()), to.min(text.len()));
        if from < to {
            spans.push(Span {
                key: (*key).to_string(),
                range: from..to,
                text: (*text).to_string(),
            });
        }
    }
    spans
}

pub fn begin(key: &str, ix: usize) {
    *state().lock().unwrap() = Some(TranscriptSelection {
        anchor_key: key.to_string(),
        anchor_ix: ix,
        dragging: true,
        spans: Vec::new(),
    });
}

pub fn begin_with_span(key: &str, text: &str, range: Range<usize>) {
    *state().lock().unwrap() = Some(TranscriptSelection {
        anchor_key: key.to_string(),
        anchor_ix: range.start,
        dragging: true,
        spans: vec![Span {
            key: key.to_string(),
            range,
            text: text.to_string(),
        }],
    });
}

pub fn drag_anchor(key: &str) -> Option<usize> {
    let guard = state().lock().unwrap();
    let selection = guard.as_ref()?;
    (selection.dragging && selection.anchor_key == key).then_some(selection.anchor_ix)
}

pub fn update_spans(spans: Vec<Span>) -> bool {
    let mut guard = state().lock().unwrap();
    let Some(selection) = guard.as_mut() else {
        return false;
    };
    if selection.spans == spans {
        return false;
    }
    selection.spans = spans;
    true
}

pub fn end_drag(key: &str) -> Option<String> {
    let mut guard = state().lock().unwrap();
    let selection = guard.as_mut()?;
    if selection.anchor_key != key || !selection.dragging {
        return None;
    }
    selection.dragging = false;
    if selection.spans.iter().all(|span| span.range.is_empty()) {
        *guard = None;
        return None;
    }
    Some(join_spans(&selection.spans))
}

pub fn clear_if_owner(key: &str) -> bool {
    let mut guard = state().lock().unwrap();
    if guard
        .as_ref()
        .is_some_and(|selection| selection.anchor_key == key && !selection.dragging)
    {
        *guard = None;
        return true;
    }
    false
}

pub fn wash_range(key: &str) -> Option<Range<usize>> {
    let guard = state().lock().unwrap();
    let selection = guard.as_ref()?;
    selection
        .spans
        .iter()
        .find(|span| span.key == key && !span.range.is_empty())
        .map(|span| span.range.clone())
}

pub fn selected_text() -> Option<String> {
    let guard = state().lock().unwrap();
    let selection = guard.as_ref()?;
    if selection.spans.iter().all(|span| span.range.is_empty()) {
        return None;
    }
    Some(join_spans(&selection.spans))
}

#[cfg(test)]
pub fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn join_spans(spans: &[Span]) -> String {
    spans
        .iter()
        .filter(|span| !span.range.is_empty())
        .map(|span| &span.text[span.range.clone()])
        .collect::<Vec<_>>()
        .join("\n")
}

/// Word range around `ix` for double-click selection.
pub fn word_range(text: &str, ix: usize) -> Range<usize> {
    let mut ix = ix.min(text.len());
    while ix > 0 && !text.is_char_boundary(ix) {
        ix -= 1;
    }
    let is_word = |character: char| character.is_alphanumeric() || character == '_';
    let before = text[..ix].chars().next_back();
    let at = text[ix..].chars().next();
    if !at.is_some_and(is_word) && !before.is_some_and(is_word) {
        return match at {
            Some(character) if !character.is_whitespace() => ix..ix + character.len_utf8(),
            _ => ix..ix,
        };
    }
    let start = text[..ix]
        .char_indices()
        .rev()
        .take_while(|(_, character)| is_word(*character))
        .last()
        .map(|(index, _)| index)
        .unwrap_or(ix);
    let end = text[ix..]
        .char_indices()
        .take_while(|(_, character)| is_word(*character))
        .last()
        .map(|(index, character)| ix + index + character.len_utf8())
        .unwrap_or(ix);
    start..end
}

#[cfg(test)]
mod tests {
    use super::*;

    fn elements<'a>() -> Vec<(&'a str, &'a str)> {
        vec![
            ("p1", "first paragraph"),
            ("p2", "second"),
            ("p3", "third one"),
        ]
    }

    #[test]
    fn spans_within_one_element() {
        let spans = resolve_spans(&elements(), (0, 6), (0, 15));
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].key, "p1");
        assert_eq!(&spans[0].text[spans[0].range.clone()], "paragraph");
        assert_eq!(resolve_spans(&elements(), (0, 15), (0, 6)), spans);
    }

    #[test]
    fn spans_across_elements_cover_middles_whole() {
        let spans = resolve_spans(&elements(), (0, 6), (2, 5));
        assert_eq!(spans.len(), 3);
        assert_eq!(&spans[0].text[spans[0].range.clone()], "paragraph");
        assert_eq!(&spans[1].text[spans[1].range.clone()], "second");
        assert_eq!(&spans[2].text[spans[2].range.clone()], "third");
        assert_eq!(resolve_spans(&elements(), (2, 5), (0, 6)), spans);
    }

    #[test]
    fn drag_lifecycle_and_copy_joins() {
        let _state = test_lock();
        begin("p1", 6);
        assert_eq!(drag_anchor("p1"), Some(6));
        let spans = resolve_spans(&elements(), (0, 6), (1, 6));
        assert!(update_spans(spans.clone()));
        assert!(!update_spans(spans));
        assert_eq!(wash_range("p1"), Some(6..15));
        assert_eq!(wash_range("p2"), Some(0..6));
        assert_eq!(end_drag("p1").as_deref(), Some("paragraph\nsecond"));
        assert_eq!(selected_text().as_deref(), Some("paragraph\nsecond"));
        assert!(clear_if_owner("p1"));
        assert_eq!(selected_text(), None);
    }

    #[test]
    fn double_click_and_unicode_word_ranges() {
        let _state = test_lock();
        begin_with_span("p1", "hello world", 6..11);
        assert_eq!(end_drag("p1").as_deref(), Some("world"));
        let unicode = "héllo wörld";
        assert_eq!(&unicode[word_range(unicode, 2)], "héllo");
    }
}
