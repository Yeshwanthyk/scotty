use std::ops::Range;

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkdownBlockKind {
    Paragraph,
    Heading(u8),
    Quote,
    Code,
    ListItem,
    Rule,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MarkdownStyle {
    pub strong: bool,
    pub emphasis: bool,
    pub code: bool,
    pub strike: bool,
    pub link: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkdownRange {
    pub range: Range<usize>,
    pub style: MarkdownStyle,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkdownBlock {
    pub kind: MarkdownBlockKind,
    pub text: String,
    pub ranges: Vec<MarkdownRange>,
}

#[derive(Default)]
struct InlineState {
    strong: usize,
    emphasis: usize,
    strike: usize,
    link: usize,
}

impl InlineState {
    fn style(&self, code: bool) -> MarkdownStyle {
        MarkdownStyle {
            strong: self.strong > 0,
            emphasis: self.emphasis > 0,
            code,
            strike: self.strike > 0,
            link: self.link > 0,
        }
    }
}

struct BlockBuilder {
    kind: MarkdownBlockKind,
    text: String,
    ranges: Vec<MarkdownRange>,
}

impl BlockBuilder {
    fn new(kind: MarkdownBlockKind) -> Self {
        Self {
            kind,
            text: String::new(),
            ranges: Vec::new(),
        }
    }

    fn append(&mut self, text: &str, style: MarkdownStyle) {
        if text.is_empty() {
            return;
        }
        let start = self.text.len();
        self.text.push_str(text);
        let end = self.text.len();
        if style == MarkdownStyle::default() {
            return;
        }
        if let Some(last) = self.ranges.last_mut()
            && last.style == style
            && last.range.end == start
        {
            last.range.end = end;
        } else {
            self.ranges.push(MarkdownRange {
                range: start..end,
                style,
            });
        }
    }

    fn finish(self) -> Option<MarkdownBlock> {
        let text = self.text.trim_end().to_string();
        if text.trim().is_empty() {
            return None;
        }
        let end = text.len();
        let ranges = self
            .ranges
            .into_iter()
            .filter_map(|mut range| {
                if range.range.start >= end {
                    return None;
                }
                range.range.end = range.range.end.min(end);
                Some(range)
            })
            .collect();
        Some(MarkdownBlock {
            kind: self.kind,
            text,
            ranges,
        })
    }
}

struct ListState {
    next: Option<u64>,
}

struct MarkdownBuilder {
    blocks: Vec<MarkdownBlock>,
    current: Option<BlockBuilder>,
    inline: InlineState,
    lists: Vec<ListState>,
    quote_depth: usize,
    in_item: bool,
}

impl MarkdownBuilder {
    fn new() -> Self {
        Self {
            blocks: Vec::new(),
            current: None,
            inline: InlineState::default(),
            lists: Vec::new(),
            quote_depth: 0,
            in_item: false,
        }
    }

    fn start(&mut self, kind: MarkdownBlockKind) {
        self.flush();
        self.current = Some(BlockBuilder::new(kind));
    }

    fn ensure(&mut self) {
        if self.current.is_none() {
            let kind = if self.in_item {
                MarkdownBlockKind::ListItem
            } else if self.quote_depth > 0 {
                MarkdownBlockKind::Quote
            } else {
                MarkdownBlockKind::Paragraph
            };
            self.current = Some(BlockBuilder::new(kind));
        }
    }

    fn append(&mut self, text: &str, code: bool) {
        self.ensure();
        let style = self.inline.style(code);
        if let Some(current) = &mut self.current {
            current.append(text, style);
        }
    }

    fn flush(&mut self) {
        if let Some(block) = self.current.take().and_then(BlockBuilder::finish) {
            self.blocks.push(block);
        }
    }

    fn start_item(&mut self) {
        self.start(MarkdownBlockKind::ListItem);
        self.in_item = true;
        let depth = self.lists.len().saturating_sub(1);
        let marker = self.lists.last_mut().map_or_else(
            || "• ".to_string(),
            |list| match &mut list.next {
                Some(next) => {
                    let marker = format!("{next}. ");
                    *next = next.saturating_add(1);
                    marker
                }
                None => "• ".to_string(),
            },
        );
        if let Some(current) = &mut self.current {
            current.append(
                &format!("{}{marker}", "  ".repeat(depth)),
                MarkdownStyle::default(),
            );
        }
    }

    fn finish(mut self) -> Vec<MarkdownBlock> {
        self.flush();
        self.blocks
    }
}

pub fn parse_markdown(source: &str) -> Vec<MarkdownBlock> {
    let options = Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_TABLES
        | Options::ENABLE_GFM;
    let mut output = MarkdownBuilder::new();

    for event in Parser::new_ext(source, options) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => output.ensure(),
                Tag::Heading { level, .. } => {
                    output.start(MarkdownBlockKind::Heading(heading_level(level)))
                }
                Tag::BlockQuote(_) => output.quote_depth += 1,
                Tag::CodeBlock(_) => output.start(MarkdownBlockKind::Code),
                Tag::List(next) => output.lists.push(ListState { next }),
                Tag::Item => output.start_item(),
                Tag::Emphasis => output.inline.emphasis += 1,
                Tag::Strong => output.inline.strong += 1,
                Tag::Strikethrough => output.inline.strike += 1,
                Tag::Link { .. } => output.inline.link += 1,
                Tag::TableRow => output.start(MarkdownBlockKind::Paragraph),
                Tag::TableCell
                    if output
                        .current
                        .as_ref()
                        .is_some_and(|block| !block.text.is_empty()) =>
                {
                    output.append("  |  ", false);
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph if !output.in_item => output.flush(),
                TagEnd::Heading(_) | TagEnd::CodeBlock | TagEnd::TableRow => output.flush(),
                TagEnd::BlockQuote(_) => {
                    output.flush();
                    output.quote_depth = output.quote_depth.saturating_sub(1);
                }
                TagEnd::List(_) => {
                    output.flush();
                    output.lists.pop();
                }
                TagEnd::Item => {
                    output.flush();
                    output.in_item = false;
                }
                TagEnd::Emphasis => {
                    output.inline.emphasis = output.inline.emphasis.saturating_sub(1)
                }
                TagEnd::Strong => output.inline.strong = output.inline.strong.saturating_sub(1),
                TagEnd::Strikethrough => {
                    output.inline.strike = output.inline.strike.saturating_sub(1)
                }
                TagEnd::Link => output.inline.link = output.inline.link.saturating_sub(1),
                _ => {}
            },
            Event::Text(text) => output.append(&text, false),
            Event::Code(code) => output.append(&code, true),
            Event::InlineMath(math) => output.append(&format!("${math}$"), true),
            Event::DisplayMath(math) => output.append(&math, true),
            Event::Html(html) | Event::InlineHtml(html) => output.append(&html, true),
            Event::FootnoteReference(label) => output.append(&format!("[^{label}]"), false),
            Event::SoftBreak => output.append(" ", false),
            Event::HardBreak => output.append("\n", false),
            Event::Rule => {
                output.flush();
                output.blocks.push(MarkdownBlock {
                    kind: MarkdownBlockKind::Rule,
                    text: String::new(),
                    ranges: Vec::new(),
                });
            }
            Event::TaskListMarker(checked) => {
                output.append(if checked { "[✓] " } else { "[ ] " }, false)
            }
        }
    }

    output.finish()
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

#[cfg(test)]
mod tests {
    use super::{MarkdownBlockKind, parse_markdown};

    #[test]
    fn parses_the_reported_bold_lines_without_markdown_delimiters() {
        let blocks = parse_markdown(
            "**Planning safe scanning workaround**\n\n**Testing scanning with symlink move**",
        );

        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].kind, MarkdownBlockKind::Paragraph);
        assert_eq!(blocks[0].text, "Planning safe scanning workaround");
        assert!(blocks[0].ranges[0].style.strong);
        assert_eq!(blocks[1].text, "Testing scanning with symlink move");
    }

    #[test]
    fn parses_headings_lists_code_links_and_quotes_into_bounded_blocks() {
        let blocks = parse_markdown(
            "## Result\n\n- **done** with `cargo test`\n- [docs](https://example.test)\n\n> safe\n\n```sh\nnpm test\n```",
        );

        assert_eq!(blocks[0].kind, MarkdownBlockKind::Heading(2));
        assert_eq!(blocks[1].kind, MarkdownBlockKind::ListItem);
        assert!(blocks[1].text.starts_with("• done"));
        assert!(blocks[1].ranges.iter().any(|range| range.style.strong));
        assert!(blocks[1].ranges.iter().any(|range| range.style.code));
        assert!(blocks[2].ranges.iter().any(|range| range.style.link));
        assert_eq!(blocks[3].kind, MarkdownBlockKind::Quote);
        assert_eq!(blocks[4].kind, MarkdownBlockKind::Code);
    }
}
