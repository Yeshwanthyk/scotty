//! Diffs as the web reads them (`ui/src/data/diff.ts`): a turn's `git diff` split into files, or
//! each tool's changes, folded into the session's files newest first.

use crate::api::{Change, Item, Turn};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineKind {
    Add,
    Del,
    Ctx,
    Hunk,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub kind: LineKind,
    pub text: String,
    pub old: Option<u64>,
    pub new: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FileDiff {
    pub path: String,
    /// `add`, `delete` or `update`.
    pub kind: String,
    pub lines: Vec<Line>,
    pub added: usize,
    pub removed: usize,
}

fn file(path: String, kind: String, lines: Vec<Line>) -> FileDiff {
    let added = lines.iter().filter(|l| l.kind == LineKind::Add).count();
    let removed = lines.iter().filter(|l| l.kind == LineKind::Del).count();
    FileDiff {
        path,
        kind,
        lines,
        added,
        removed,
    }
}

/// `@@ -12,3 +12,4 @@` → (12, 12).
fn hunk_head(raw: &str) -> Option<(u64, u64)> {
    let rest = raw.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(' ')?;
    let rest = rest.strip_prefix('+')?;
    let (new, rest) = rest.split_once(' ')?;
    rest.starts_with("@@").then_some(())?;
    let first = |s: &str| s.split(',').next()?.parse().ok();
    Some((first(old)?, first(new)?))
}

/// A unified diff body (hunks only, or with ---/+++ headers) as numbered lines.
pub fn parse_hunks(diff: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    let (mut old, mut next) = (0, 0);
    for raw in diff.split('\n') {
        if let Some((o, n)) = hunk_head(raw) {
            old = o;
            next = n;
            lines.push(Line {
                kind: LineKind::Hunk,
                text: raw.to_string(),
                old: None,
                new: None,
            });
        } else if raw.starts_with("+++") || raw.starts_with("---") || raw.starts_with('\\') {
            continue;
        } else if let Some(text) = raw.strip_prefix('+') {
            lines.push(Line {
                kind: LineKind::Add,
                text: text.into(),
                old: None,
                new: Some(next),
            });
            next += 1;
        } else if let Some(text) = raw.strip_prefix('-') {
            lines.push(Line {
                kind: LineKind::Del,
                text: text.into(),
                old: Some(old),
                new: None,
            });
            old += 1;
        } else if let Some(text) = raw.strip_prefix(' ').filter(|_| !lines.is_empty()) {
            lines.push(Line {
                kind: LineKind::Ctx,
                text: text.into(),
                old: Some(old),
                new: Some(next),
            });
            old += 1;
            next += 1;
        }
    }
    lines
}

/// Codex gives a new file's content as its diff, and an edit as hunks.
pub fn change_diff(change: &Change) -> FileDiff {
    let lines = if change.kind == "add"
        && !change.diff.contains("\n@@")
        && !change.diff.starts_with("@@")
    {
        change
            .diff
            .strip_suffix('\n')
            .unwrap_or(&change.diff)
            .split('\n')
            .enumerate()
            .map(|(i, t)| Line {
                kind: LineKind::Add,
                text: t.into(),
                old: None,
                new: Some(i as u64 + 1),
            })
            .collect()
    } else {
        parse_hunks(&change.diff)
    };
    file(change.path.clone(), change.kind.clone(), lines)
}

/// A turn's cumulative `git diff` split into files.
pub fn split_diff(diff: &str) -> Vec<FileDiff> {
    let mut parts: Vec<&str> = Vec::new();
    let mut start = None;
    let mut at = 0;
    for line in diff.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            if let Some(s) = start {
                parts.push(&diff[s..at]);
            }
            start = Some(at);
        }
        at += line.len();
    }
    if let Some(s) = start {
        parts.push(&diff[s..]);
    }
    parts
        .into_iter()
        .map(|part| {
            let header = part.lines().next().unwrap_or("");
            let path = header
                .split_once(" b/")
                .map_or("file", |(_, b)| b)
                .trim()
                .to_string();
            let kind = if part.lines().any(|l| l.starts_with("new file mode")) {
                "add"
            } else if part.lines().any(|l| l.starts_with("deleted file mode")) {
                "delete"
            } else {
                "update"
            };
            file(path, kind.into(), parse_hunks(part))
        })
        .collect()
}

/// Files changed across the session, the one changed last first. A file touched in several turns
/// keeps every turn's hunks, oldest first.
pub fn session_changes(turns: &[Turn]) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    for turn in turns {
        let from_diff = split_diff(&turn.diff);
        let changes = if from_diff.is_empty() {
            turn.items
                .iter()
                .flat_map(|i| {
                    if let Item::Tool(t) = i {
                        t.changes.iter().map(change_diff).collect()
                    } else {
                        Vec::new()
                    }
                })
                .collect()
        } else {
            from_diff
        };
        for f in changes {
            let earlier = files
                .iter()
                .position(|e| e.path == f.path)
                .map(|i| files.remove(i));
            match earlier {
                Some(e) if f.kind != "delete" => {
                    let mut lines = e.lines;
                    lines.extend(f.lines);
                    files.push(file(f.path, e.kind, lines));
                }
                _ => files.push(f),
            }
        }
    }
    files.reverse();
    files
}

/// 999, 1.2k, 12k.
pub fn compact(n: usize) -> String {
    if n >= 1000 {
        let k = n as f64 / 1000.0;
        if n >= 10_000 {
            format!("{k:.0}k")
        } else {
            format!("{k:.1}k")
        }
    } else {
        n.to_string()
    }
}

/// What `DiffLines` draws: lines, with unchanged runs over 8 folded to 3 either side.
pub enum Shown<'a> {
    Line(&'a Line),
    Fold(usize),
}

pub fn fold(lines: &[Line]) -> Vec<Shown<'_>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].kind == LineKind::Ctx {
            let start = i;
            while i < lines.len() && lines[i].kind == LineKind::Ctx {
                i += 1;
            }
            let run = &lines[start..i];
            if run.len() > 8 {
                out.extend(run[..3].iter().map(Shown::Line));
                out.push(Shown::Fold(run.len() - 6));
                out.extend(run[run.len() - 3..].iter().map(Shown::Line));
            } else {
                out.extend(run.iter().map(Shown::Line));
            }
        } else {
            out.push(Shown::Line(&lines[i]));
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hunks_number_as_the_web_numbers_them() {
        let lines = parse_hunks("--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@ fn main\n a\n-b\n+c\n+d\n");
        assert_eq!(lines.len(), 5);
        assert_eq!((lines[1].old, lines[1].new), (Some(3), Some(3)));
        assert_eq!((lines[2].kind, lines[2].old), (LineKind::Del, Some(4)));
        assert_eq!((lines[4].kind, lines[4].new), (LineKind::Add, Some(5)));
        assert_eq!(compact(1234), "1.2k");
        assert_eq!(compact(12_345), "12k");
    }

    #[test]
    fn a_git_diff_splits_into_files() {
        let files = split_diff(
            "diff --git a/a.rs b/a.rs\nnew file mode 100644\n@@ -0,0 +1 @@\n+x\ndiff --git a/b.rs b/b.rs\n@@ -1 +1 @@\n-y\n+z\n",
        );
        assert_eq!(files.len(), 2);
        assert_eq!(
            (
                files[0].path.as_str(),
                files[0].kind.as_str(),
                files[0].added
            ),
            ("a.rs", "add", 1)
        );
        assert_eq!((files[1].added, files[1].removed), (1, 1));
    }
}
