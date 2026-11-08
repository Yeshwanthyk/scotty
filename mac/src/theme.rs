//! The web app's look, as Rune values. Every colour, size and radius is a token from
//! `ui/src/global.css`; change it there first, then here, so the Mac app and the web stay one design.

use rune::{Color, TextStyle};
use rune_kit::MarkdownStyle;

/// `--thread-width: 44rem`.
pub const THREAD_WIDTH: f32 = 704.0;
/// `--radius`, and `--radius-md`.
pub const RADIUS: f32 = 10.0;
pub const RADIUS_MD: f32 = 8.0;
/// `--sidebar-width`.
pub const SIDEBAR_WIDTH: f32 = 264.0;
/// The window's top band: the tab strip, and the sidebar's head beside the traffic lights.
pub const BAR: f32 = 44.0;
/// The session header (`.session-header`).
pub const HEADER: f32 = 48.0;
/// The system font, as the web's `-apple-system` resolves on a Mac.
pub const SANS: &str = "System Font";

pub const BODY: TextStyle = TextStyle::new(15.0, 400.0).lh(24.0);
pub const COMPOSER: TextStyle = TextStyle::new(14.0, 400.0).lh(22.0);
pub const META: TextStyle = TextStyle::new(13.0, 400.0).lh(18.0);
pub const META_STRONG: TextStyle = TextStyle::new(13.0, 500.0).lh(18.0);
pub const TITLE: TextStyle = TextStyle::new(14.0, 600.0).lh(20.0);
pub const ROW: TextStyle = TextStyle::new(13.5, 400.0).lh(18.0);
pub const ROW_STRONG: TextStyle = TextStyle::new(13.5, 500.0).lh(18.0);
/// Tool rows, the live row and "Worked for": 12.5px.
pub const LOG: TextStyle = TextStyle::new(12.5, 400.0).lh(18.0);
pub const LOG_MONO: TextStyle = TextStyle::new(12.0, 400.0).lh(18.0).mono();
pub const SMALL: TextStyle = TextStyle::new(11.5, 400.0).lh(14.0);
pub const PILL: TextStyle = TextStyle::new(11.5, 500.0).lh(14.0);
pub const HEAD: TextStyle = TextStyle::new(12.0, 500.0).lh(16.0);
pub const CODE: TextStyle = TextStyle::new(12.0, 400.0).lh(18.0).mono();
pub const PAGE_TITLE: TextStyle = TextStyle::new(20.0, 600.0).lh(26.0);

#[derive(Clone, Copy)]
pub struct Palette {
    pub bg: Color,
    pub sidebar: Color,
    pub surface: Color,
    pub raised: Color,
    pub sunken: Color,
    pub hover: Color,
    pub selected: Color,
    pub ink: Color,
    pub muted: Color,
    pub quiet: Color,
    pub line: Color,
    pub line_strong: Color,
    pub accent: Color,
    pub link: Color,
    pub working: Color,
    pub attention: Color,
    pub done: Color,
    pub danger: Color,
    pub warning: Color,
    pub diff_add: Color,
    pub diff_del: Color,
    pub diff_add_bg: Color,
    pub diff_del_bg: Color,
    pub shadow: Color,
    pub scrim: Color,
    /// Send and primary buttons: `--send-fill`, which is ink.
    pub button: Color,
    pub button_ink: Color,
}

fn hex(s: &str) -> Color {
    rune::color::hex(s).expect("a token colour")
}

fn rgba(r: u8, g: u8, b: u8, a: f32) -> Color {
    Color {
        r: f32::from(r) / 255.0,
        g: f32::from(g) / 255.0,
        b: f32::from(b) / 255.0,
        a,
    }
}

pub fn palette(dark: bool) -> Palette {
    if dark {
        Palette {
            bg: hex("#161615"),
            sidebar: hex("#121211"),
            surface: hex("#1d1d1c"),
            raised: hex("#242423"),
            sunken: hex("#131312"),
            hover: rgba(255, 255, 255, 0.045),
            selected: rgba(255, 255, 255, 0.075),
            ink: hex("#ecebe8"),
            muted: hex("#a3a29d"),
            quiet: hex("#6e6d69"),
            line: rgba(255, 255, 255, 0.07),
            line_strong: rgba(255, 255, 255, 0.11),
            accent: hex("#d9693f"),
            link: hex("#7cc3ec"),
            working: hex("#6cb6f0"),
            attention: hex("#e0b057"),
            done: hex("#62c58e"),
            danger: hex("#f07266"),
            warning: hex("#e0b057"),
            diff_add: hex("#62c58e"),
            diff_del: hex("#f07266"),
            diff_add_bg: rgba(98, 197, 142, 0.1),
            diff_del_bg: rgba(240, 114, 102, 0.09),
            shadow: rgba(0, 0, 0, 0.35),
            scrim: rgba(0, 0, 0, 0.45),
            button: hex("#ecebe8"),
            button_ink: hex("#161615"),
        }
    } else {
        Palette {
            bg: hex("#fbfbfa"),
            sidebar: hex("#f5f5f3"),
            surface: hex("#ffffff"),
            raised: hex("#f2f2f0"),
            sunken: hex("#f6f6f4"),
            hover: rgba(0, 0, 0, 0.045),
            selected: rgba(0, 0, 0, 0.07),
            ink: hex("#1b1b1a"),
            muted: hex("#62615d"),
            quiet: hex("#959490"),
            line: rgba(0, 0, 0, 0.075),
            line_strong: rgba(0, 0, 0, 0.12),
            accent: hex("#c2552f"),
            link: hex("#1d6fb8"),
            working: hex("#2f8fdc"),
            attention: hex("#c98a14"),
            done: hex("#2f9b62"),
            danger: hex("#cf3b2e"),
            warning: hex("#b07a12"),
            diff_add: hex("#2f9b62"),
            diff_del: hex("#cf3b2e"),
            diff_add_bg: rgba(47, 155, 98, 0.1),
            diff_del_bg: rgba(207, 59, 46, 0.08),
            shadow: rgba(0, 0, 0, 0.08),
            scrim: rgba(0, 0, 0, 0.18),
            button: hex("#1b1b1a"),
            button_ink: hex("#ffffff"),
        }
    }
}

/// The answer's Markdown (`.markdown` in `global.css`): 15/1.6, sunken code, hairline rules.
pub fn markdown(dark: bool) -> MarkdownStyle {
    let p = palette(dark);
    MarkdownStyle::neutral(dark)
        .text(p.ink)
        .muted(p.muted)
        .link(p.link)
        .link_underline(p.line_strong)
        .inline_code_bg(p.raised)
        .code_block(p.sunken, p.line)
        .code_block_padding(14.0, 12.0)
        .rule(p.line)
        .quote_rule(p.line_strong)
        .body_font(BODY)
        .strong_weight(600.0)
        .list(22.0, 6.0)
}

/// rune-kit's controls (the tab strip) in the web's tokens.
pub fn kit(dark: bool) -> rune_kit::Kit {
    let p = palette(dark);
    let mut k = rune_kit::Kit::neutral(dark);
    let c = &mut k.c;
    c.bg_deep = p.bg;
    c.hover = p.hover;
    c.pressed = p.selected;
    c.text_base = p.ink;
    c.text_muted = p.muted;
    c.text_faint = p.quiet;
    c.icon_base = p.muted;
    c.icon_muted = p.quiet;
    c.border_muted = p.line;
    c.border_strong = p.line_strong;
    c.bg_accent = p.working;
    k.ty.ui_compact = META;
    k
}

/// The web's icons (`ui/src/components/Icon.tsx`): a 16-point grid, 1.5 strokes, round ends.
pub mod icons {
    use rune::Icon;

    macro_rules! stroke {
        ($name:ident, $id:literal, $d:literal) => {
            pub static $name: Icon = Icon {
                name: $id,
                view: 16.0,
                body: concat!(r#"<path d=""#, $d, r#"" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"#),
            };
        };
    }
    macro_rules! filled {
        ($name:ident, $id:literal, $d:literal) => {
            pub static $name: Icon = Icon { name: $id, view: 16.0, body: concat!(r#"<path d=""#, $d, r#"" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>"#) };
        };
    }

    stroke!(PLUS, "s-plus", "M8 3.25v9.5M3.25 8h9.5");
    stroke!(
        FILTER,
        "s-filter",
        "M2.75 4.25h10.5M4.75 8h6.5M6.75 11.75h2.5"
    );
    stroke!(
        SEARCH,
        "s-search",
        "M7 11.75a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5ZM10.5 10.5l3.25 3.25"
    );
    stroke!(
        SIDEBAR,
        "s-sidebar",
        "M2.75 3.25h10.5v9.5H2.75zM6.25 3.25v9.5"
    );
    stroke!(PANEL, "s-panel", "M2.75 3.25h10.5v9.5H2.75zM9.75 3.25v9.5");
    stroke!(
        SETTINGS,
        "s-settings",
        "M2.75 4.75h6.5M11.75 4.75h1.5M2.75 11.25h1.5M6.75 11.25h6.5M10.5 3.25v3M5.5 9.75v3"
    );
    stroke!(
        BRANCH,
        "s-branch",
        "M4.75 2.75v10.5M11.25 6.25a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM11.25 6.25c0 3-6.5 2.5-6.5 5.5"
    );
    stroke!(
        REPO,
        "s-repo",
        "M3.75 12.25V3.75c0-.55.45-1 1-1h7.5v8.5h-7.5a1 1 0 0 0-1 1Zm0 0c0 .55.45 1 1 1h7.5"
    );
    stroke!(
        CHEVRON_RIGHT,
        "s-chevron-right",
        "M6.5 4.25 10.25 8 6.5 11.75"
    );
    stroke!(
        CHEVRON_DOWN,
        "s-chevron-down",
        "M4.25 6.5 8 10.25l3.75-3.75"
    );
    stroke!(ARROW_UP, "s-arrow-up", "M8 12.75V3.5M4 7.25 8 3.25l4 4");
    stroke!(CHECK, "s-check", "m3.5 8.25 2.75 2.75 6.25-6.5");
    stroke!(X, "s-x", "M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5");
    stroke!(
        ALERT,
        "s-alert",
        "M8 13.75a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5ZM8 5v3.5M8 10.75v.25"
    );
    stroke!(FILE, "s-file", "M4.25 2.75h4.5l3 3v7.5h-7.5zM8.75 2.75v3h3");
    stroke!(
        FILE_PLUS,
        "s-file-plus",
        "M4.25 2.75h4.5l3 3v7.5h-7.5zM8.75 2.75v3h3M8 8v3.5M6.25 9.75h3.5"
    );
    stroke!(
        FILE_MINUS,
        "s-file-minus",
        "M4.25 2.75h4.5l3 3v7.5h-7.5zM8.75 2.75v3h3M6.25 9.75h3.5"
    );
    stroke!(
        GLOBE,
        "s-globe",
        "M8 13.75a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5ZM2.5 8h11M8 2.25c1.5 1.6 2.25 3.5 2.25 5.75S9.5 12.15 8 13.75C6.5 12.15 5.75 10.25 5.75 8S6.5 3.85 8 2.25Z"
    );
    stroke!(
        NODES,
        "s-nodes",
        "M4.5 6a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5ZM11.5 13.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5ZM4.5 6v2.5c0 1.5 1 2.5 2.5 2.5h2.75"
    );
    stroke!(COPY, "s-copy", "M5.75 5.75h7v7h-7zM3.25 10.25v-7h7");
    stroke!(
        REFRESH,
        "s-refresh",
        "M13.25 8a5.25 5.25 0 1 1-1.54-3.71M13.25 2.75v2.5h-2.5"
    );
    stroke!(
        LIST,
        "s-list",
        "M5.75 4.25h7.5M5.75 8h7.5M5.75 11.75h7.5M2.75 4.25h.01M2.75 8h.01M2.75 11.75h.01"
    );
    stroke!(
        COMPRESS,
        "s-compress",
        "M5.25 2.75v2.5h-2.5M10.75 2.75v2.5h2.5M5.25 13.25v-2.5h-2.5M10.75 13.25v-2.5h2.5"
    );
    stroke!(
        EXTERNAL,
        "s-external",
        "M9.25 2.75h4v4M13.25 2.75 7.5 8.5M11.25 9.25v4h-8.5v-8.5h4"
    );
    stroke!(
        DIFF,
        "s-diff",
        "M4.75 2.75v6.5M1.75 6h6M8.25 13h6M11.25 4.25V13"
    );
    stroke!(
        CIRCLE,
        "s-circle",
        "M8 13.25a5.25 5.25 0 1 0 0-10.5 5.25 5.25 0 0 0 0 10.5Z"
    );
    stroke!(
        MOON,
        "s-moon",
        "M13.25 9.6A5.5 5.5 0 1 1 6.4 2.75a4.5 4.5 0 0 0 6.85 6.85Z"
    );
    filled!(STOP, "s-stop", "M4.5 4.5h7v7h-7z");
    filled!(PLAY, "s-play", "M5 3.5v9l7-4.5z");
    pub static MORE: Icon = Icon {
        name: "s-more",
        view: 16.0,
        body: r#"<circle cx="3.5" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor"/>"#,
    };
    /// Scotty's mark (`BrandMark` in `ui/src/components/Sidebar.tsx`): rings of dots around a
    /// bright centre on a dark tile, drawn at rest.
    pub static MARK: Icon = Icon {
        name: "s-mark",
        view: 20.0,
        body: r##"<rect width="20" height="20" rx="5.5" fill="#0b1216"/><circle cx="10" cy="10" r="1.25" fill="#cfe3ea"/><circle cx="13.40" cy="10.00" r="0.75" fill="#cfe3ea" fill-opacity="0.8"/><circle cx="11.70" cy="12.94" r="0.75" fill="#cfe3ea" fill-opacity="0.8"/><circle cx="8.30" cy="12.94" r="0.75" fill="#cfe3ea" fill-opacity="0.8"/><circle cx="6.60" cy="10.00" r="0.75" fill="#cfe3ea" fill-opacity="0.8"/><circle cx="8.30" cy="7.06" r="0.75" fill="#cfe3ea" fill-opacity="0.8"/><circle cx="11.70" cy="7.06" r="0.75" fill="#cfe3ea" fill-opacity="0.8"/><circle cx="15.94" cy="12.87" r="0.65" fill="#cfe3ea" fill-opacity="0.5"/><circle cx="13.45" cy="15.63" r="0.65" fill="#cfe3ea" fill-opacity="0.5"/><circle cx="9.86" cy="16.60" r="0.65" fill="#cfe3ea" fill-opacity="0.5"/><circle cx="6.31" cy="15.47" r="0.65" fill="#cfe3ea" fill-opacity="0.5"/><circle cx="3.94" cy="12.61" r="0.65" fill="#cfe3ea" fill-opacity="0.5"/><circle cx="3.49" cy="8.92" r="0.65" fill="#cfe3ea" fill-opacity="0.5"/><circle cx="5.11" cy="5.57" r="0.65" fill="#cfe3ea" fill-opacity="0.5"/><circle cx="8.28" cy="3.63" r="0.65" fill="#cfe3ea" fill-opacity="0.5"/><circle cx="12.00" cy="3.71" r="0.65" fill="#cfe3ea" fill-opacity="0.5"/><circle cx="15.08" cy="5.79" r="0.65" fill="#cfe3ea" fill-opacity="0.5"/><circle cx="16.55" cy="9.20" r="0.65" fill="#cfe3ea" fill-opacity="0.5"/><circle cx="16.09" cy="17.68" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="12.69" cy="19.42" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="8.88" cy="19.74" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="5.24" cy="18.57" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="2.32" cy="16.09" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="0.58" cy="12.69" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="0.26" cy="8.88" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="1.43" cy="5.24" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="3.91" cy="2.32" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="7.31" cy="0.58" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="11.12" cy="0.26" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="14.76" cy="1.43" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="17.68" cy="3.91" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="19.42" cy="7.31" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="19.74" cy="11.12" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/><circle cx="18.57" cy="14.76" r="0.55" fill="#cfe3ea" fill-opacity="0.28"/>"##,
    };
}
