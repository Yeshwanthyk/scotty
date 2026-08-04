//! GPUI paint and pointer plumbing for transcript text selection.
//!
//! Adapted from Comet's markdown renderer. Painted transcript elements register
//! their text layouts every frame so a drag can span separately rendered and
//! virtualized blocks while preserving a plain-text clipboard projection.

use std::cell::RefCell;
use std::ops::Range;
use std::sync::Arc;

use gpui::{
    AnyElement, BorderStyle, Bounds, DispatchPhase, Hsla, InteractiveText, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, SharedString, StyledText, Window, canvas, div,
    point, prelude::*, px, quad, size,
};

use crate::transcript_selection;

struct RegistryEntry {
    key: Arc<str>,
    text: SharedString,
    layout: gpui::TextLayout,
}

thread_local! {
    static REGISTRY: RefCell<Vec<RegistryEntry>> = const { RefCell::new(Vec::new()) };
}

/// Clear the frame-scoped layout registry. Paint this before transcript rows.
pub fn selection_frame_reset() -> impl IntoElement {
    canvas(
        |_, _, _| (),
        |_, _, _, _| REGISTRY.with(|registry| registry.borrow_mut().clear()),
    )
    .absolute()
    .w(px(0.0))
    .h(px(0.0))
}

/// Wrap painted text with selection registration, pointer handling, and wash.
pub fn selectable(
    key: String,
    text: SharedString,
    styled: StyledText,
    selection_wash: Hsla,
) -> AnyElement {
    selectable_with_links(key, text, styled, Vec::new(), selection_wash)
}

/// Selectable text whose highlighted link ranges retain native click behavior.
pub fn selectable_with_links(
    key: String,
    text: SharedString,
    styled: StyledText,
    links: Vec<(Range<usize>, String)>,
    selection_wash: Hsla,
) -> AnyElement {
    let layout = styled.layout().clone();
    let text_element = if links.is_empty() {
        styled.into_any_element()
    } else {
        let (ranges, urls): (Vec<_>, Vec<_>) = links.into_iter().unzip();
        InteractiveText::new(SharedString::from(format!("{key}:links")), styled)
            .on_click(ranges, move |clicked_index, _, cx| {
                if let Some(url) = urls.get(clicked_index) {
                    cx.open_url(url);
                }
            })
            .into_any_element()
    };
    let selection_key: Arc<str> = key.into();
    let registry_text = text.clone();
    let underlay_layout = layout.clone();
    let underlay_key = selection_key.clone();
    let underlay = canvas(
        |_, _, _| (),
        move |_, _, window, _| {
            if let Some(range) = transcript_selection::wash_range(&underlay_key) {
                for bounds in range_rects(&underlay_layout, &range) {
                    window.paint_quad(quad(
                        bounds,
                        px(0.0),
                        selection_wash,
                        px(0.0),
                        gpui::transparent_black(),
                        BorderStyle::default(),
                    ));
                }
            }
            REGISTRY.with(|registry| {
                registry.borrow_mut().push(RegistryEntry {
                    key: underlay_key.clone(),
                    text: registry_text.clone(),
                    layout: underlay_layout.clone(),
                });
            });
            register_selection_listeners(window, &underlay_key, &registry_text, &underlay_layout);
        },
    )
    .absolute()
    .size_full();

    div()
        .relative()
        .child(underlay)
        .child(text_element)
        .into_any_element()
}

fn registry_point(position: gpui::Point<gpui::Pixels>) -> Option<(usize, usize)> {
    REGISTRY.with(|registry| {
        let registry = registry.borrow();
        let mut best: Option<(usize, f32)> = None;
        for (element_ix, entry) in registry.iter().enumerate() {
            let bounds = entry.layout.bounds();
            let distance = if position.y < bounds.top() {
                f32::from(bounds.top() - position.y)
            } else if position.y > bounds.bottom() {
                f32::from(position.y - bounds.bottom())
            } else {
                0.0
            };
            if best.is_none_or(|(_, current)| distance < current) {
                best = Some((element_ix, distance));
            }
            if distance == 0.0 {
                break;
            }
        }
        let (element_ix, _) = best?;
        let index = match registry[element_ix].layout.index_for_position(position) {
            Ok(index) | Err(index) => index,
        };
        Some((element_ix, index))
    })
}

fn resolve_drag(anchor_key: &str, anchor_ix: usize, head: (usize, usize)) -> bool {
    REGISTRY.with(|registry| {
        let registry = registry.borrow();
        let Some(anchor_element_ix) = registry
            .iter()
            .position(|entry| entry.key.as_ref() == anchor_key)
        else {
            return false;
        };
        let elements: Vec<(&str, &str)> = registry
            .iter()
            .map(|entry| (entry.key.as_ref(), entry.text.as_ref()))
            .collect();
        let spans =
            transcript_selection::resolve_spans(&elements, (anchor_element_ix, anchor_ix), head);
        transcript_selection::update_spans(spans)
    })
}

fn register_selection_listeners(
    window: &mut Window,
    key: &Arc<str>,
    text: &SharedString,
    layout: &gpui::TextLayout,
) {
    {
        let (key, text, layout) = (key.clone(), text.clone(), layout.clone());
        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, _| {
            if phase != DispatchPhase::Bubble || event.button != MouseButton::Left {
                return;
            }
            if layout.bounds().contains(&event.position) {
                let index = match layout.index_for_position(event.position) {
                    Ok(index) | Err(index) => index,
                };
                match event.click_count {
                    2 => transcript_selection::begin_with_span(
                        &key,
                        &text,
                        transcript_selection::word_range(&text, index),
                    ),
                    count if count >= 3 => {
                        transcript_selection::begin_with_span(&key, &text, 0..text.len());
                    }
                    _ => transcript_selection::begin(&key, index),
                }
                window.refresh();
            } else if transcript_selection::clear_if_owner(&key) {
                window.refresh();
            }
        });
    }
    {
        let key = key.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, _| {
            if phase != DispatchPhase::Bubble || !event.dragging() {
                return;
            }
            let Some(anchor_ix) = transcript_selection::drag_anchor(&key) else {
                return;
            };
            let Some(head) = registry_point(event.position) else {
                return;
            };
            if resolve_drag(&key, anchor_ix, head) {
                window.refresh();
            }
        });
    }
    {
        let key = key.clone();
        window.on_mouse_event(move |_: &MouseUpEvent, phase, _, _cx| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            if let Some(selected) = transcript_selection::end_drag(&key) {
                #[cfg(any(target_os = "linux", target_os = "freebsd"))]
                _cx.write_to_primary(gpui::ClipboardItem::new_string(selected));
                #[cfg(not(any(target_os = "linux", target_os = "freebsd")))]
                let _ = selected;
            }
        });
    }
}

fn range_rects(layout: &gpui::TextLayout, range: &Range<usize>) -> Vec<Bounds<gpui::Pixels>> {
    let mut rectangles = Vec::new();
    let line_height = layout.line_height();
    let mut current = range.start;
    let mut guard = 0;
    while current < range.end && guard < 256 {
        guard += 1;
        let Some(start) = layout.position_for_index(current) else {
            break;
        };
        let (segment_end, next) = match layout.position_for_index(range.end) {
            Some(end) if end.y == start.y => (range.end, range.end),
            _ => {
                let (mut low, mut high) = (current, range.end);
                while high - low > 1 {
                    let middle = low + (high - low) / 2;
                    match layout.position_for_index(middle) {
                        Some(position) if position.y == start.y => low = middle,
                        _ => high = middle,
                    }
                }
                (low, high)
            }
        };
        if let Some(end) = layout.position_for_index(segment_end)
            && end.x > start.x
        {
            rectangles.push(Bounds::new(
                point(start.x, start.y),
                size(end.x - start.x, line_height),
            ));
        }
        if next <= current {
            break;
        }
        current = next;
    }
    rectangles
}
