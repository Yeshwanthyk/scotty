//! Home: what the window shows with no tab open. A dithered beam over the brand, a composer that
//! starts a session, and four cards read from the session list: activity by day, the latest
//! sessions, the ones waiting on the owner, and this week against last week.

use rune::{Align, El, Pixels, Shape, Side, SurfaceFit, TextEdit, TextStyle, canvas, col, el, icon, row, text, text_input};
use rune_kit::Kit;

use crate::api::{Session, Status};
use crate::shell::{icon_button, spinner};
use crate::theme::{COMPOSER, META, META_STRONG, PAGE_TITLE, Palette, RADIUS, ROW, SMALL, icons};
use crate::{State, time};

/// The dithered art's size in pixels, and the side of one dither dot.
const ART_W: usize = 2400;
const ART_H: usize = 640;
const DOT: usize = 4;
/// Weeks in the activity grid.
const WEEKS: i64 = 20;
const DAY: f64 = 86_400_000.0;

/// The repositories the composer's menu offers: the latest ones sessions ran in.
const REPOS: usize = 8;

/// The home page's own state: the composer's text and the repository picked for it.
#[derive(Default)]
pub struct Home {
    pub prompt: TextEdit,
    /// Picked from the menu; until then the composer offers the latest session's repository.
    pub repo: Option<String>,
    pub repo_menu: bool,
}

/// The repositories sessions ran in, latest first.
pub fn recent_repos(sessions: &[Session]) -> Vec<String> {
    let mut by_latest: Vec<&Session> = sessions.iter().filter(|x| !x.display.repository.is_empty()).collect();
    by_latest.sort_by(|a, b| b.display.active_at.cmp(&a.display.active_at));
    let mut repos: Vec<String> = Vec::new();
    for x in by_latest {
        if !repos.contains(&x.display.repository) {
            repos.push(x.display.repository.clone());
        }
    }
    repos
}

/// The repository a session started from the composer goes to: the one picked, else the
/// sidebar's repository filter, else the latest session's.
pub fn repo_for(s: &State) -> Option<String> {
    s.home.repo.clone().or_else(|| s.repo_filter.clone()).or_else(|| recent_repos(&s.sessions).into_iter().next())
}

/// The art behind the brand, for each appearance, drawn once.
pub struct Art {
    pub dark: Pixels,
    pub light: Pixels,
}

impl Art {
    pub fn new() -> Art {
        let art = Art { dark: Pixels::new(), light: Pixels::new() };
        paint(&art.dark, true);
        paint(&art.light, false);
        art
    }
}

pub fn page(s: &State, k: &Kit, p: &Palette, layer: &mut Vec<El>) -> El {
    let dark = s.dark.get();
    let hero = col()
        .key("home-hero")
        .w_full()
        .h(300.0)
        .pixels_fit(if dark { &s.art.dark } else { &s.art.light }, SurfaceFit::Fill)
        .items_center()
        .justify_end()
        .px(24.0)
        .pb(8.0)
        .gap(22.0)
        .child(row().key("home-brand").gap(12.0).center_y().child(icon(&icons::MARK, 34.0)).child(text("Scotty").font(TextStyle::new(30.0, 600.0).lh(36.0)).color(p.ink)))
        .child(composer(s, p));
    if s.home.repo_menu {
        layer.push(repo_menu(s, p));
    }
    let cards = col()
        .key("home-cards")
        .w_full()
        .max_w(760.0)
        .gap(14.0)
        .child(row().w_full().gap(14.0).child(activity(s, p)).child(recent(s, k, p)))
        .child(row().w_full().gap(14.0).child(waiting(s, p)).child(this_week(s, p)));
    col()
        .key("home")
        .w_full()
        .grow(1.0)
        .shrink()
        .min_h(0.0)
        .scroll(rune::ScrollSpec { stick_bottom: false })
        .child(col().w_full().items_center().pb(40.0).gap(26.0).child(hero).child(col().w_full().px(24.0).items_center().child(cards)))
}

/// "Ask Codex to…": Return opens the New session sheet with this prompt, where the repository
/// and the agent are picked.
fn composer(s: &State, p: &Palette) -> El {
    let prompt = text_input(&s.home.prompt, COMPOSER)
        .key("home-prompt")
        .label("Prompt")
        .placeholder("Ask Scotty to build, fix or explain…", p.quiet)
        .color(p.ink)
        .w_full()
        .min_h(48.0)
        .max_h(160.0)
        .on_edit(|s: &mut State| &mut s.home.prompt)
        .on_submit(|s: &mut State, _| s.start_from_home());
    let ready = !s.home.prompt.text.trim().is_empty();
    let mut send = el()
        .key("home-send")
        .role("button")
        .label("Start a session")
        .size(30.0, 30.0)
        .radius(15.0)
        .center()
        .fill(p.button)
        .child(icon(&icons::ARROW_UP, 15.0).color(p.button_ink));
    send = if ready { send.on_press(|s: &mut State| s.start_from_home()) } else { send.opacity(0.35) };
    let repo = repo_for(s).unwrap_or_else(|| "Pick a repository".to_string());
    col()
        .key("home-composer")
        .w_full()
        .max_w(680.0)
        .padding(14.0)
        .gap(10.0)
        .radius(18.0)
        .fill(p.surface.alpha(0.9))
        .border(1.0, p.line_strong)
        .shadow(14.0, 40.0, p.shadow)
        .child(prompt)
        .child(
            row()
                .w_full()
                .gap(6.0)
                .center_y()
                .child(icon_button("home-new", &icons::PLUS, "New session (⌘N)", p).on_press(|s: &mut State| s.start_from_home()))
                .child(
                    row()
                        .key("home-repo")
                        .role("button")
                        .label(format!("Repository: {repo}"))
                        .h(26.0)
                        .px(8.0)
                        .gap(6.0)
                        .radius(8.0)
                        .center_y()
                        .hover(p.hover)
                        .fill(if s.home.repo_menu { p.hover } else { p.surface.alpha(0.0) })
                        .child(icon(&icons::REPO, 13.0).color(p.quiet))
                        .child(text(repo).font(SMALL).color(p.muted).max_lines(1))
                        .child(icon(&icons::CHEVRON_DOWN, 11.0).color(p.quiet))
                        .on_press(|s: &mut State| s.home.repo_menu = !s.home.repo_menu),
                )
                .child(el().grow(1.0))
                .child(text("Return").font(SMALL).color(p.quiet))
                .child(send),
        )
}

/// The composer's repository menu: the latest repositories sessions ran in, and a way to type
/// any other in the New session sheet.
fn repo_menu(s: &State, p: &Palette) -> El {
    let current = repo_for(s);
    let item = |key: String, label: String, on: bool| {
        row()
            .key(key)
            .role("menuitem")
            .label(label.clone())
            .w_full()
            .h(28.0)
            .px(8.0)
            .gap(8.0)
            .radius(6.0)
            .center_y()
            .hover(p.hover)
            .child(text(label).font(META).color(p.ink).grow(1.0).max_lines(1))
            .child(if on { icon(&icons::CHECK, 14.0).color(p.ink) } else { el().size(14.0, 14.0) })
    };
    let mut menu = col().key("home-repo-menu").role("menu").label("Repository").w(280.0).padding(5.0).radius(RADIUS).fill(p.surface).border(1.0, p.line_strong).shadow(8.0, 24.0, p.shadow);
    for repo in recent_repos(&s.sessions).into_iter().take(REPOS) {
        let on = current.as_deref() == Some(repo.as_str());
        let picked = repo.clone();
        menu = menu.child(item(format!("repo:{repo}"), repo, on).on_press(move |s: &mut State| {
            s.home.repo = Some(picked.clone());
            s.home.repo_menu = false;
        }));
    }
    menu = menu.child(el().w_full().h(1.0).my(4.0).fill(p.line)).child(item("repo-other".into(), "Another repository…".into(), false).on_press(|s: &mut State| {
        s.home.repo_menu = false;
        s.start_from_home();
        if let Some(d) = s.new_session.as_mut() {
            d.repo = TextEdit::new("");
        }
    }));
    menu.modal(true, |s: &mut State| s.home.repo_menu = false).anchored("home-repo", Side::Bottom, Align::Start, 6.0)
}

fn card(key: &str, title: &str, glyph: &'static rune::Icon, p: &Palette) -> El {
    col()
        .key(key)
        .w(1.0)
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .min_h(196.0)
        .padding(16.0)
        .gap(12.0)
        .radius(RADIUS + 4.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .child(row().w_full().gap(8.0).center_y().child(icon(glyph, 14.0).color(p.quiet)).child(text(title.to_string()).font(META_STRONG).color(p.muted)))
}

/// Sessions started per day over the last weeks, one square a day, Sunday on top.
fn activity(s: &State, p: &Palette) -> El {
    let now = s.now();
    let today = time::day(now);
    let start = today - weekday(today) - 7 * (WEEKS - 1);
    let mut counts = vec![0u32; usize::try_from(today - start + 1).unwrap_or(0)];
    for x in &s.sessions {
        let Some(at) = time::parse(&x.display.created_at) else { continue };
        let d = time::day(at);
        if (start..=today).contains(&d)
            && let Some(c) = usize::try_from(d - start).ok().and_then(|i| counts.get_mut(i))
        {
            *c += 1;
        }
    }
    let total: u32 = counts.iter().sum();
    let (cell, gap) = (11.0, 3.0);
    let mut shape = Shape::new();
    for (i, n) in counts.iter().enumerate() {
        let (x, y) = ((i / 7) as f32 * (cell + gap), (i % 7) as f32 * (cell + gap));
        let color = match n {
            0 => p.raised,
            1 => p.done.alpha(0.35),
            2 => p.done.alpha(0.55),
            3 => p.done.alpha(0.75),
            _ => p.done,
        };
        shape = shape.fill(vec![[x, y], [x + cell, y], [x + cell, y + cell], [x, y + cell]], color);
    }
    let width = WEEKS as f32 * (cell + gap) - gap;
    let height = 7.0 * (cell + gap) - gap;
    let grid = canvas(shape).key("home-activity-grid").label(format!("{total} sessions started in {WEEKS} weeks")).size(width, height);
    card("home-activity", "Activity", &icons::NODES, p)
        .child(row().gap(6.0).items_end().child(text(total.to_string()).font(PAGE_TITLE).color(p.ink)).child(text(format!("sessions in {WEEKS} weeks")).font(META).color(p.quiet).pb(3.0)))
        .child(grid)
}

/// The three sessions touched last; each opens in a tab.
fn recent(s: &State, k: &Kit, p: &Palette) -> El {
    let now = s.now();
    let mut all: Vec<&Session> = s.sessions.iter().collect();
    all.sort_by(|a, b| b.display.active_at.cmp(&a.display.active_at));
    let mut c = card("home-recent", "Recent sessions", &icons::LIST, p);
    if all.is_empty() {
        return c.child(text("Nothing yet. Start one above.").font(META).color(p.quiet));
    }
    let mut rows = col().w_full().gap(2.0);
    for x in all.iter().take(3) {
        let id = x.id().to_string();
        let status = s.status_of(x);
        let mut line = row()
            .key(format!("home-recent:{id}"))
            .role("button")
            .label(format!("Open {}", x.display.title))
            .w_full()
            .h(36.0)
            .px(8.0)
            .gap(8.0)
            .center_y()
            .radius(RADIUS - 2.0)
            .hover(p.hover);
        line = match status {
            Status::Working | Status::Starting => line.child(spinner(10.0, p.working, k)),
            _ => line.child(el().size(10.0, 10.0).center().child(el().size(6.0, 6.0).radius(3.0).fill(dot(status, p)))),
        };
        rows = rows.child(
            line.child(text(x.display.title.clone()).font(ROW).color(p.ink).max_lines(1).grow(1.0).shrink().min_w(0.0))
                .child(text(time::ago(&x.display.active_at, now)).font(SMALL).color(p.quiet))
                .on_press(move |s: &mut State| s.open_session(&id)),
        );
    }
    c = c.child(rows);
    if all.len() > 3 {
        c = c.child(text(format!("{} more in the sidebar", all.len() - 3)).font(SMALL).color(p.quiet).px(8.0));
    }
    c
}

/// Sessions with something for the owner: a reply not read yet, or a failure.
fn waiting(s: &State, p: &Palette) -> El {
    let mut mine: Vec<(&Session, Status)> = s.sessions.iter().map(|x| (x, s.status_of(x))).filter(|(_, st)| matches!(st, Status::Unseen | Status::Failed)).collect();
    mine.sort_by(|a, b| b.0.display.active_at.cmp(&a.0.display.active_at));
    let mut c = card("home-waiting", "Needs you", &icons::ALERT, p);
    if mine.is_empty() {
        return c.child(col().w_full().grow(1.0).center().gap(4.0).child(icon(&icons::CHECK, 18.0).color(p.done)).child(text("Nothing is waiting on you.").font(META).color(p.quiet)));
    }
    c = c.child(row().gap(6.0).items_end().child(text(mine.len().to_string()).font(PAGE_TITLE).color(p.ink)).child(text(if mine.len() == 1 { "session" } else { "sessions" }).font(META).color(p.quiet).pb(3.0)));
    for (x, st) in mine.iter().take(3) {
        let id = x.id().to_string();
        c = c.child(
            row()
                .key(format!("home-waiting:{id}"))
                .role("button")
                .label(format!("Open {}", x.display.title))
                .w_full()
                .h(30.0)
                .px(8.0)
                .gap(8.0)
                .center_y()
                .radius(RADIUS - 2.0)
                .hover(p.hover)
                .child(el().size(6.0, 6.0).radius(3.0).fill(dot(*st, p)))
                .child(text(x.display.title.clone()).font(META).color(p.ink).max_lines(1).grow(1.0).shrink().min_w(0.0))
                .child(text(st.label()).font(SMALL).color(dot(*st, p)))
                .on_press(move |s: &mut State| s.open_session(&id)),
        );
    }
    c
}

/// Sessions started in the last seven days against the seven before, what is working now, and
/// the turns the week's sessions took.
fn this_week(s: &State, p: &Palette) -> El {
    let now = s.now();
    let started = |from: f64, to: f64| s.sessions.iter().filter(|x| time::parse(&x.display.created_at).is_some_and(|t| t > from && t <= to)).count();
    let week = started(now - 7.0 * DAY, now);
    let before = started(now - 14.0 * DAY, now - 7.0 * DAY);
    let working = s.sessions.iter().filter(|x| matches!(s.status_of(x), Status::Working | Status::Starting)).count();
    let turns: u64 = s.sessions.iter().filter(|x| time::parse(&x.display.active_at).is_some_and(|t| t > now - 7.0 * DAY)).map(|x| x.progress.turns).sum();
    let delta = week as i64 - before as i64;
    let (delta_text, delta_color) = match delta {
        0 => ("same as last week".to_string(), p.quiet),
        d if d > 0 => (format!("+{d} on last week"), p.done),
        d => (format!("{d} on last week"), p.danger),
    };
    let stat = |key: &str, n: String, label: &str, under: El| col().key(key).w(1.0).grow(1.0).min_w(0.0).gap(2.0).child(text(n).font(PAGE_TITLE).color(p.ink)).child(text(label.to_string()).font(META).color(p.muted)).child(under);
    card("home-week", "This week", &icons::REFRESH, p).child(
        row()
            .w_full()
            .gap(12.0)
            .child(stat("home-week-started", week.to_string(), "started", text(delta_text).font(SMALL).color(delta_color)))
            .child(stat("home-week-working", working.to_string(), "working now", text(if working == 0 { "all quiet" } else { "live" }).font(SMALL).color(if working == 0 { p.quiet } else { p.working })))
            .child(stat("home-week-turns", turns.to_string(), "turns", text("this week").font(SMALL).color(p.quiet))),
    )
}

fn dot(status: Status, p: &Palette) -> rune::Color {
    match status {
        Status::Failed => p.danger,
        Status::Unseen => p.attention,
        Status::Working | Status::Starting => p.working,
        Status::Idle => p.done,
        Status::Asleep | Status::Stopped => p.quiet,
    }
}

/// 0 for Sunday, as the grid's rows run. 1970-01-01, day 0, was a Thursday.
fn weekday(day: i64) -> i64 {
    (day + 4).rem_euclid(7)
}

// ── Art ────────────────────────────────────────────────────────────────────────────────────

/// A beam of light falling into a ringed glow above the brand, ordered-dithered into a few tones
/// of the brand mark and faded into the page at the bottom and sides.
fn paint(pixels: &Pixels, dark: bool) {
    let tones: [[f32; 3]; 5] = if dark {
        [rgb(0x12_1a_1d), rgb(0x16_2e_35), rgb(0x22_4f_58), rgb(0x4b_8c_93), rgb(0xcf_e3_ea)]
    } else {
        [rgb(0xf4_f2_ee), rgb(0xdc_e8_e9), rgb(0xc4_db_dd), rgb(0x9c_c3_c7), rgb(0x5e_98_9e)]
    };
    let page = if dark { rgb(0x16_16_15) } else { rgb(0xfb_fb_fa) };
    let (cols, rows) = (ART_W / DOT, ART_H / DOT);
    let mut out = vec![0u8; ART_W * ART_H * 4];
    for cy in 0..rows {
        let v = (cy as f32 + 0.5) / rows as f32;
        for cx in 0..cols {
            let u = (cx as f32 + 0.5) / cols as f32;
            let (dx, dy) = ((u - 0.5) * (cols as f32 / rows as f32), v - 0.30);
            let dist = (dx * dx + dy * dy).sqrt();
            // Dark under the brand and the composer, bright above them.
            let below = 1.0 - smooth(0.30, 0.62, v);
            let sky = 0.10 * (1.0 - v);
            let beam = (-((u - 0.5) / 0.04).powi(2)).exp() * (0.35 + 0.65 * (1.0 - v)) * 0.75 * below;
            let halo = (-((u - 0.5) / 0.18).powi(2)).exp() * 0.18 * below;
            let glow = (-dist * 3.2).exp() * 0.6 * below;
            let rings = (0.5 + 0.5 * (dist * 40.0).cos()).powi(6) * (-dist * 1.6).exp() * 0.34 * (0.4 + 0.6 * below);
            let level = (sky + beam + halo + glow + rings).clamp(0.0, 1.0);
            let t = level * (tones.len() - 1) as f32;
            let base = t.floor();
            let i = (base as usize).min(tones.len() - 1);
            let pick = if t - base > bayer(cx, cy) { (i + 1).min(tones.len() - 1) } else { i };
            let c = tones[pick];
            let fade = smooth(0.70, 1.0, v).max(smooth(0.30, 0.5, (u - 0.5).abs()) * 0.85);
            let c = mix(c, page, fade);
            for py in 0..DOT {
                for px in 0..DOT {
                    let o = ((cy * DOT + py) * ART_W + cx * DOT + px) * 4;
                    out[o..o + 4].copy_from_slice(&[to8(c[0]), to8(c[1]), to8(c[2]), 255]);
                }
            }
        }
    }
    pixels.set(ART_W as u32, ART_H as u32, out);
}

/// The 8×8 Bayer threshold at a cell, in [0, 1).
fn bayer(x: usize, y: usize) -> f32 {
    const M: [u8; 64] = [
        0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
    ];
    (f32::from(M[(y % 8) * 8 + x % 8]) + 0.5) / 64.0
}

fn rgb(hex: u32) -> [f32; 3] {
    [((hex >> 16) & 0xff) as f32 / 255.0, ((hex >> 8) & 0xff) as f32 / 255.0, (hex & 0xff) as f32 / 255.0]
}

fn mix(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn smooth(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn to8(x: f32) -> u8 {
    (x.clamp(0.0, 1.0) * 255.0).round() as u8
}
