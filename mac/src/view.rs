//! The window: the address screen until a Scotty is open, then the sidebar, the tab bar and the
//! open session's page, with ⌘K and the New session sheet over them. Colours, type and sizes come
//! from `theme.rs`, which mirrors the web's tokens.

use rune::{Cx, El, TextStyle, col, el, icon, row, text, text_input};

use crate::api::{
    Authority, Change, Conversation, Display, Identity, Item, Origin, PlanStep, Progress, Session,
    Stop, Tool, Turn, TurnState,
};
use crate::live::Link;
use crate::servers::Server;
use crate::theme::{self, BODY, COMPOSER, META, META_STRONG, Palette, RADIUS, SMALL, icons};
use crate::{Appearance, Auth, Conn, Draft, State, session, shell};

pub fn view(s: &State, cx: &mut Cx<State>) -> El {
    if let Some(me) = &s.me {
        crate::menu::sync(me, &s.menu_shown, crate::menu::shown(s));
    }
    let dark = match s.appearance {
        Appearance::System => cx.system_dark(),
        Appearance::Light => false,
        Appearance::Dark => true,
    };
    s.dark.set(dark);
    let p = theme::pick(theme::palette(dark), cx.accent(), s.key_window, dark);
    let k = if dark { &s.kit_dark } else { &s.kit_light };
    let Some(server) = &s.server else {
        return connect(s, cx.titlebar_inset(), &p);
    };
    if s.auth != Auth::Ready {
        return sign_in(s, server, cx.titlebar_inset(), k, &p);
    }
    let md = if dark {
        &s.markdown_dark
    } else {
        &s.markdown_light
    };
    let mut layer = Vec::new();
    let page = match s.conn() {
        Some(conn) => session::page(s, conn, k, md, &p, &mut layer),
        None => crate::home::page(s, k, &p),
    };
    let main = col()
        .key("main")
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .h_full()
        .fill(p.bg)
        .child(shell::tab_bar(s, cx, k, &p, &mut layer))
        .child(page);
    let mut window = row().w_full().h_full().fill(p.bg);
    if s.sidebar {
        window = window.child(shell::sidebar(s, cx, k, &p));
    }
    crate::palette::view(s, k, &p, &mut layer);
    new_session(s, &p, &mut layer);
    rune_kit::root(window.child(main), layer)
}

/// First launch, or "Switch Scotty": the Scottys this Mac has opened, or an address. Signing in
/// happens in the browser, on that Scotty's own Cloudflare Access page.
fn connect(s: &State, inset: f32, p: &Palette) -> El {
    let mut list = col().key("servers").w_full().gap(8.0);
    for server in &s.servers {
        let open = server.clone();
        list = list.child(
            row()
                .key(&format!("server:{}", server.url))
                .role("button")
                .label(&format!("Open {}", server.name))
                .w_full()
                .px(16.0)
                .py(12.0)
                .gap(12.0)
                .center_y()
                .radius(RADIUS)
                .fill(p.raised)
                .hover(p.hover)
                .child(icon(&icons::MARK, 22.0))
                .child(
                    col()
                        .grow(1.0)
                        .shrink()
                        .min_w(0.0)
                        .child(
                            text(server.name.clone())
                                .font(theme::TITLE)
                                .color(p.ink)
                                .max_lines(1),
                        )
                        .child(
                            text(server.url.clone())
                                .font(META)
                                .color(p.quiet)
                                .max_lines(1),
                        ),
                )
                .child(text("Open").font(META_STRONG).color(p.muted))
                .on_press(move |s: &mut State| s.open(open.clone())),
        );
    }
    let address = text_input(&s.address, BODY)
        .key("address")
        .label("Your Scotty's address")
        .placeholder("scotty.example.com", p.quiet)
        .color(p.ink)
        .grow(1.0)
        .shrink()
        .py(12.0)
        .on_edit(|s: &mut State| &mut s.address)
        .on_submit(|s: &mut State, _| s.open_typed());
    let field = row()
        .key("address-field")
        .w_full()
        .pl(16.0)
        .pr(6.0)
        .gap(8.0)
        .center_y()
        .radius(RADIUS)
        .fill(p.surface)
        .border(1.0, p.line_strong)
        .child(address)
        .child(
            el().key("open-address")
                .role("button")
                .label("Open")
                .px(14.0)
                .py(8.0)
                .radius(8.0)
                .fill(p.button)
                .child(text("Open").font(META_STRONG).color(p.button_ink))
                .on_press(|s: &mut State| s.open_typed()),
        );
    let mut card = col()
        .key("connect")
        .w_full()
        .max_w(440.0)
        .gap(16.0)
        .child(icon(&icons::MARK, 36.0))
        .child(text("Open your Scotty").font(TextStyle::new(22.0, 600.0).lh(28.0)).color(p.ink))
        .child(text("Type the address of your Scotty. You'll sign in through its Cloudflare Access in your browser.").font(META).color(p.muted).wrap());
    if !s.servers.is_empty() {
        card = card
            .child(list)
            .child(text("Or another Scotty").font(META).color(p.quiet));
    }
    card = card.child(field);
    if let Some(why) = &s.address_error {
        card = card.child(
            row()
                .gap(6.0)
                .center_y()
                .child(icon(&icons::ALERT, 13.0).color(p.danger))
                .child(text(why.clone()).font(META).color(p.danger).wrap()),
        );
    }
    col()
        .w_full()
        .h_full()
        .fill(p.bg)
        .child(row().w_full().h(52.0).pl(12.0 + inset).window_drag())
        .child(
            row()
                .w_full()
                .grow(1.0)
                .justify_center()
                .center_y()
                .px(24.0)
                .pb(52.0)
                .child(card),
        )
}

/// A Scotty behind Cloudflare Access with no good token: one button signs in through the browser,
/// and the window carries on (list, tabs, sockets) once the token comes back.
fn sign_in(s: &State, server: &Server, inset: f32, k: &rune_kit::Kit, p: &Palette) -> El {
    let host = server
        .url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();
    let primary = |key: &str, label: &str| {
        row()
            .key(key)
            .role("button")
            .label(label)
            .w_full()
            .h(44.0)
            .gap(8.0)
            .justify_center()
            .center_y()
            .radius(RADIUS)
            .fill(p.button)
            .child(
                text(label.to_string())
                    .font(META_STRONG)
                    .color(p.button_ink),
            )
            .child(icon(&icons::EXTERNAL, 14.0).color(p.button_ink))
    };
    let quiet = |key: &str, label: &str| {
        el().key(key)
            .role("button")
            .label(label)
            .px(10.0)
            .py(6.0)
            .radius(8.0)
            .hover(p.hover)
            .child(text(label.to_string()).font(META_STRONG).color(p.muted))
    };
    let lead = match &s.auth {
        Auth::Failed(_) => "Signing in didn't finish. Try again; your browser opens the same page.",
        _ => {
            "This Scotty is behind Cloudflare Access. Sign in with your browser, and the app carries on here."
        }
    };
    let mut card = col()
        .key("sign-in-card")
        .w_full()
        .max_w(400.0)
        .gap(16.0)
        .child(icon(&icons::MARK, 36.0))
        .child(
            col()
                .w_full()
                .gap(6.0)
                .child(
                    text("Sign in to Scotty")
                        .font(TextStyle::new(22.0, 600.0).lh(28.0))
                        .color(p.ink),
                )
                .child(text(host).font(META).color(p.quiet).max_lines(1)),
        )
        .child(text(lead).font(META).color(p.muted).wrap());
    match &s.auth {
        Auth::Waiting(opened) => {
            let mut waiting = col()
                .key("sign-in-waiting")
                .role("status")
                .w_full()
                .px(16.0)
                .py(14.0)
                .gap(12.0)
                .radius(RADIUS)
                .fill(p.raised)
                .border(1.0, p.line)
                .child(
                    row()
                        .gap(10.0)
                        .center_y()
                        .child(shell::spinner(13.0, p.muted, k))
                        .child(
                            text(if opened.is_some() {
                                "Finish signing in in your browser…"
                            } else {
                                "Opening your browser…"
                            })
                            .font(META_STRONG)
                            .color(p.ink),
                        ),
                );
            let mut actions = row().gap(4.0).center_y().ml(-10.0);
            if opened.is_some() {
                actions = actions.child(
                    quiet("sign-in-reopen", "Open the page again")
                        .on_press(|s: &mut State| s.reopen_sign_in()),
                );
            }
            waiting = waiting.child(actions.child(
                quiet("sign-in-cancel", "Cancel").on_press(|s: &mut State| s.cancel_sign_in()),
            ));
            card = card.child(waiting);
        }
        Auth::Failed(why) => {
            card = card
                .child(
                    row()
                        .key("sign-in-error")
                        .role("alert")
                        .gap(6.0)
                        .center_y()
                        .child(icon(&icons::ALERT, 13.0).color(p.danger))
                        .child(text(why.clone()).font(META).color(p.danger).wrap()),
                )
                .child(primary("sign-in", "Try again").on_press(|s: &mut State| s.sign_in()));
        }
        Auth::Needed | Auth::Ready => {
            card = card.child(
                primary("sign-in", "Sign in with Cloudflare").on_press(|s: &mut State| s.sign_in()),
            )
        }
    }
    card = card.child(el().w_full().h(1.0).fill(p.line)).child(
        row()
            .w_full()
            .center_y()
            .child(
                text("The sign-in stays in your Keychain.")
                    .font(META)
                    .color(p.quiet)
                    .grow(1.0)
                    .shrink(),
            )
            .child(quiet("switch-scotty", "Another Scotty").on_press(|s: &mut State| s.switch())),
    );
    col()
        .key("sign-in-screen")
        .w_full()
        .h_full()
        .fill(p.bg)
        .child(row().w_full().h(52.0).pl(12.0 + inset).window_drag())
        .child(
            row()
                .w_full()
                .grow(1.0)
                .justify_center()
                .center_y()
                .px(24.0)
                .pb(52.0)
                .child(card),
        )
}

/// The New session sheet (`NewSession.tsx`): what to do, where, and which agent.
fn new_session(s: &State, p: &Palette, layer: &mut Vec<El>) {
    let Some(d) = &s.new_session else { return };
    let agent = crate::api::agent_name(d.agent);
    let prompt = text_input(&d.prompt, COMPOSER)
        .key("new-prompt")
        .label("Prompt")
        .placeholder(
            format!("Ask {agent} to build, fix or explain… or paste a GitHub link"),
            p.quiet,
        )
        .color(p.ink)
        .w_full()
        .min_h(66.0)
        .max_h(240.0)
        .on_edit(|s: &mut State| &mut s.new_session.as_mut().expect("the sheet is open").prompt)
        .on_submit(|s: &mut State, _| s.create());
    let repo = text_input(&d.repo, theme::CODE.lh(20.0))
        .key("new-repo")
        .label("Repository")
        .placeholder("owner/repo", p.quiet)
        .color(p.ink)
        .grow(1.0)
        .shrink()
        .on_edit(|s: &mut State| &mut s.new_session.as_mut().expect("the sheet is open").repo)
        .on_submit(|s: &mut State, _| s.create());
    let repo_field = row()
        .h(32.0)
        .px(10.0)
        .gap(8.0)
        .radius(RADIUS - 2.0)
        .center_y()
        .border(1.0, p.line)
        .fill(p.bg)
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .child(icon(&icons::REPO, 14.0).color(p.quiet))
        .child(repo);
    let mut agents = row()
        .h(32.0)
        .padding(3.0)
        .gap(2.0)
        .radius(RADIUS - 2.0)
        .fill(p.raised);
    for kind in ["codex", "claude"] {
        let mut chip = row()
            .key(&format!("agent:{kind}"))
            .role("radio")
            .label(crate::api::agent_name(kind))
            .h_full()
            .px(12.0)
            .radius(6.0)
            .center()
            .child(
                text(crate::api::agent_name(kind))
                    .font(META_STRONG)
                    .color(if d.agent == kind { p.ink } else { p.muted }),
            )
            .on_press(move |s: &mut State| {
                if let Some(d) = s.new_session.as_mut() {
                    d.agent = kind;
                }
            });
        if d.agent == kind {
            chip = chip.fill(p.surface);
        }
        agents = agents.child(chip);
    }
    let ready = !d.prompt.text.trim().is_empty() && !d.busy;
    let mut create = row()
        .key("create")
        .role("button")
        .label("Start")
        .h(32.0)
        .px(14.0)
        .gap(6.0)
        .radius(16.0)
        .center()
        .fill(p.button)
        .child(
            text(if d.busy { "Starting…" } else { "Start" })
                .font(META_STRONG)
                .color(p.button_ink),
        )
        .child(icon(&icons::ARROW_UP, 13.0).color(p.button_ink));
    create = if ready {
        create.on_press(|s: &mut State| s.create())
    } else {
        create.opacity(0.5)
    };
    let mut panel = col()
        .key("new-session")
        .role("dialog")
        .label("New session")
        .w_full()
        .max_w(620.0)
        .padding(18.0)
        .gap(14.0)
        .radius(16.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .shadow(12.0, 32.0, p.shadow)
        .child(
            row()
                .w_full()
                .center_y()
                .child(
                    text("New session")
                        .font(theme::TITLE)
                        .color(p.ink)
                        .grow(1.0),
                )
                .child(crate::palette::keycap("esc", p)),
        )
        .child(prompt)
        .child(
            row()
                .w_full()
                .gap(10.0)
                .center_y()
                .child(repo_field)
                .child(agents)
                .child(create),
        );
    if !d.error.is_empty() {
        panel = panel.child(
            row()
                .gap(6.0)
                .center_y()
                .child(icon(&icons::ALERT, 13.0).color(p.danger))
                .child(text(d.error.clone()).font(META).color(p.danger).wrap()),
        );
    }
    let panel = panel
        .child(text("Return starts it.").font(SMALL).color(p.quiet))
        .modal(true, |s: &mut State| s.new_session = None);
    layer.push(
        el().key("new-scrim")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .fill(p.scrim)
            .a11y_hidden(),
    );
    layer.push(
        col()
            .key("new-layer")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .px(16.0)
            .pt(96.0)
            .items_center()
            .child(panel),
    );
}

// ── Scenes ─────────────────────────────────────────────────────────────────────────────────

/// Headless scenes, built from sample sessions (no network). The clock is pinned so ages read
/// the same in every snapshot.
pub const SCENES: &[(&str, fn(&mut State))] = &[
    ("connect", |s| {
        s.servers = vec![server()];
    }),
    ("connect-error", |s| {
        s.address = rune::TextEdit::new("not an address");
        s.address_error = Some("That isn't an address. It looks like scotty.example.com.".into());
    }),
    ("list", list),
    ("list-light", |s| {
        list(s);
        s.appearance = Appearance::Light;
    }),
    ("empty", |s| {
        open(s);
        s.listed = true;
    }),
    ("session", |s| {
        list(s);
        tabs(s);
    }),
    ("session-light", |s| {
        list(s);
        tabs(s);
        s.appearance = Appearance::Light;
    }),
    ("session-open", |s| {
        list(s);
        tabs(s);
        for key in ["s-auth:log:t2", "s-auth:tool:c3", "s-auth:explore:r1"] {
            s.open.insert(key.into());
        }
    }),
    ("session-live", |s| {
        list(s);
        tabs(s);
        s.select(1);
    }),
    ("steer", |s| {
        list(s);
        tabs(s);
        s.select(1);
        if let Some(c) = s.conn_mut() {
            c.draft = rune::TextEdit::new("Also keep the old route working until the app ships");
            c.note = "Queued".into();
        }
    }),
    ("diff", |s| {
        list(s);
        tabs(s);
        s.panel = true;
    }),
    ("diff-light", |s| {
        list(s);
        tabs(s);
        s.panel = true;
        s.appearance = Appearance::Light;
    }),
    ("booting", |s| {
        list(s);
        tabs(s);
        show(
            s,
            "s-boot",
            vec![turn(
                "b1",
                "Fix flaky checkout test on Safari",
                Vec::new(),
                0.2,
                None,
                TurnState::Streaming,
            )],
        );
    }),
    ("stopped", |s| {
        list(s);
        tabs(s);
        show(s, "s-flaky", vec![profile_turn()]);
    }),
    ("failed", |s| {
        list(s);
        tabs(s);
        show(s, "s-failed", Vec::new());
    }),
    // Stop asks first while the agent is mid-turn.
    ("confirm-stop", |s| {
        list(s);
        tabs(s);
        s.select(1);
        s.act("stop");
    }),
    ("palette", |s| {
        list(s);
        tabs(s);
        s.open_palette();
    }),
    ("palette-query", |s| {
        list(s);
        tabs(s);
        s.open_palette();
        if let Some(f) = s.finder.as_mut() {
            f.query = rune::TextEdit::new("web");
        }
    }),
    ("palette-light", |s| {
        list(s);
        tabs(s);
        s.appearance = Appearance::Light;
        s.open_palette();
    }),
    ("new-session", |s| {
        list(s);
        tabs(s);
        s.new_session = Some(Draft {
            prompt: rune::TextEdit::new(""),
            repo: rune::TextEdit::new("acme/web"),
            agent: "codex",
            busy: false,
            error: String::new(),
        });
    }),
    ("no-sidebar", |s| {
        list(s);
        tabs(s);
        s.sidebar = false;
    }),
];

const NOW: &str = "2026-11-07T15:00:00Z";
const MIN: f64 = 60_000.0;

fn now() -> f64 {
    crate::time::parse(NOW).unwrap_or(0.0)
}

fn server() -> Server {
    Server {
        name: "scotty.example.com".into(),
        url: "https://scotty.example.com".into(),
    }
}

fn open(s: &mut State) {
    s.server = Some(server());
    s.now = Some(now());
    s.list_link = Link::Open;
}

fn at(mins: f64) -> String {
    crate::time::iso(now() - mins * MIN)
}

#[derive(Clone)]
struct Sample {
    id: &'static str,
    title: &'static str,
    repo: &'static str,
    lifecycle: &'static str,
    working: bool,
    turns: u64,
    mins: f64,
    agent: &'static str,
    origin: Option<Origin>,
    stop: Option<&'static str>,
}

fn sample(x: Sample) -> Session {
    let authority = match x.lifecycle {
        "booting" => Authority::Transitioning {
            phase: "container".into(),
        },
        "failed" => Authority::Stable {
            lifecycle: "failed".into(),
            stop: None,
            failure: Some(crate::api::Failure {
                code: "workspace".into(),
                recovery: "resume".into(),
            }),
        },
        lifecycle => Authority::Stable {
            lifecycle: lifecycle.into(),
            stop: x.stop.map(|reason| Stop {
                reason: reason.into(),
                exit_code: (reason == "crashed").then_some(137),
                max: None,
            }),
            failure: None,
        },
    };
    Session {
        identity: Identity { id: x.id.into() },
        authority,
        display: Display {
            title: x.title.into(),
            repository: x.repo.into(),
            branch: format!("scotty/{}", x.id),
            prompt: x.title.into(),
            agent_kind: x.agent.into(),
            size: "standard-2".into(),
            created_at: at(x.mins + 30.0),
            active_at: at(x.mins),
            origin: x.origin,
        },
        progress: Progress {
            working: x.working,
            turns: x.turns,
            sleeps_at: (x.lifecycle == "running" && !x.working)
                .then(|| crate::time::iso(now() + 12.0 * MIN)),
        },
    }
}

fn list(s: &mut State) {
    open(s);
    let base = Sample {
        id: "",
        title: "",
        repo: "acme/web",
        lifecycle: "running",
        working: false,
        turns: 2,
        mins: 0.0,
        agent: "codex",
        origin: None,
        stop: None,
    };
    s.sessions = vec![
        sample(Sample {
            id: "s-auth",
            title: "Move sign-in to the new session cookie",
            turns: 3,
            mins: 4.0,
            ..base.clone()
        }),
        sample(Sample {
            id: "s-live",
            title: "Add retry with backoff to the uploads queue",
            repo: "acme/api",
            working: true,
            turns: 2,
            mins: 1.0,
            ..base.clone()
        }),
        sample(Sample {
            id: "s-boot",
            title: "Fix flaky checkout test on Safari",
            lifecycle: "booting",
            turns: 1,
            mins: 0.2,
            ..base.clone()
        }),
        sample(Sample {
            id: "s-review",
            title: "Review PR #482: billing webhooks",
            repo: "acme/api",
            turns: 4,
            mins: 38.0,
            agent: "claude",
            origin: Some(Origin::Hook {
                connection: "github".into(),
                delivery: "d1".into(),
            }),
            ..base.clone()
        }),
        sample(Sample {
            id: "s-failed",
            title: "Upgrade the image pipeline to sharp 0.34",
            lifecycle: "failed",
            turns: 0,
            mins: 70.0,
            ..base.clone()
        }),
        sample(Sample {
            id: "s-nightly",
            title: "Nightly dependency bumps",
            repo: "acme/infra",
            lifecycle: "stopped",
            turns: 1,
            mins: 60.0 * 20.0,
            origin: Some(Origin::Automation {
                automation: "nightly-deps".into(),
                run: "r1".into(),
            }),
            stop: Some("ended"),
            ..base.clone()
        }),
        sample(Sample {
            id: "s-flaky",
            title: "Profile the search endpoint under load",
            repo: "acme/api",
            lifecycle: "stopped",
            turns: 5,
            mins: 60.0 * 30.0,
            stop: Some("crashed"),
            ..base.clone()
        }),
        sample(Sample {
            id: "s-docs",
            title: "Write the onboarding guide for the CLI",
            repo: "acme/cli",
            lifecycle: "stopped",
            turns: 2,
            mins: 60.0 * 24.0 * 3.0,
            stop: Some("idle"),
            ..base.clone()
        }),
        sample(Sample {
            id: "s-old",
            title: "Port the settings page to the new forms",
            lifecycle: "stopped",
            turns: 6,
            mins: 60.0 * 24.0 * 12.0,
            stop: Some("user"),
            ..base.clone()
        }),
    ];
    s.listed = true;
    // The review has a reply the owner hasn't read.
    for x in &s.sessions {
        s.seen.insert(
            x.id().to_string(),
            if x.id() == "s-review" {
                3
            } else {
                x.progress.turns
            },
        );
    }
}

/// Two sessions open as tabs: the finished auth change, and the uploads work still running.
fn tabs(s: &mut State) {
    s.open_session("s-live");
    s.open_session("s-auth");
    s.active = 0;
    let auth = Conversation {
        current_turn: "t3".into(),
        turns: vec![first_turn(), second_turn(), third_turn()],
    };
    let live = Conversation {
        current_turn: "l2".into(),
        turns: vec![live_first(), live_turn()],
    };
    for c in &mut s.conns {
        c.conversation = Some(if c.id == "s-auth" {
            auth.clone()
        } else {
            live.clone()
        });
    }
    s.tabs = vec!["s-auth".into(), "s-live".into()];
    s.active = 0;
}

/// Open `id` in a tab, with `turns` as its conversation.
fn show(s: &mut State, id: &str, turns: Vec<Turn>) {
    s.open_session(id);
    let current = turns.last().map_or(String::new(), |t| t.id.clone());
    if let Some(c) = s.conns.iter_mut().find(|c: &&mut Conn| c.id == id) {
        c.conversation = Some(Conversation {
            current_turn: current,
            turns,
        });
    }
}

fn tool(id: &str, category: &str, summary: &str, input: &str, output: &str) -> Tool {
    Tool {
        id: id.into(),
        name: if category == "run" {
            "shell".into()
        } else {
            "tool".into()
        },
        category: category.into(),
        summary: summary.into(),
        status: "completed".into(),
        input: input.into(),
        output: output.into(),
        exit_code: (category == "run").then_some(0),
        duration_ms: Some(1200.0),
        changes: Vec::new(),
        parent: None,
    }
}

fn turn(
    id: &str,
    user: &str,
    items: Vec<Item>,
    start_mins: f64,
    end_mins: Option<f64>,
    state: TurnState,
) -> Turn {
    Turn {
        id: id.into(),
        state,
        user: user.into(),
        assistant: String::new(),
        items,
        diff: String::new(),
        started_at: Some(at(start_mins)),
        ended_at: end_mins.map(at),
        files: Vec::new(),
    }
}

fn text_item(id: &str, words: &str) -> Item {
    Item::Text {
        id: id.into(),
        text: words.into(),
        done: true,
    }
}

const COOKIE_DIFF: &str = "@@ -1,14 +1,17 @@\n import { Hono } from \"hono\";\n-import { readLegacyToken } from \"./legacy\";\n+import { readSession, writeSession } from \"./session-cookie\";\n \n export const auth = new Hono();\n \n auth.post(\"/sign-in\", async (c) => {\n   const user = await verify(c.req);\n-  c.header(\"x-token\", await readLegacyToken(user));\n+  await writeSession(c, user, { maxAge: 60 * 60 * 24 * 14 });\n   return c.json({ ok: true });\n });\n \n auth.get(\"/me\", async (c) => {\n-  const user = await readLegacyToken(c.req.header(\"x-token\"));\n+  const user = await readSession(c);\n+  if (!user) return c.json({ error: \"signed out\" }, 401);\n   return c.json(user);\n });\n";

const COOKIE_NEW: &str = "import type { Context } from \"hono\";\nimport { getSignedCookie, setSignedCookie } from \"hono/cookie\";\n\nconst NAME = \"__Host-session\";\n\nexport async function readSession(c: Context) {\n  const raw = await getSignedCookie(c, c.env.SESSION_KEY, NAME);\n  return raw ? JSON.parse(raw) : null;\n}\n\nexport async function writeSession(c: Context, user: unknown, opts: { maxAge: number }) {\n  await setSignedCookie(c, NAME, JSON.stringify(user), c.env.SESSION_KEY, {\n    httpOnly: true,\n    secure: true,\n    sameSite: \"Lax\",\n    path: \"/\",\n    maxAge: opts.maxAge,\n  });\n}\n";

fn first_turn() -> Turn {
    let mut t = turn(
        "t1",
        "Sign-in still sends the legacy x-token header. Move it to the signed session cookie we added last week, and keep /me working.",
        vec![
            Item::Thinking { id: "h1".into(), text: "**Finding the sign-in path** The header is written in routes/auth.ts and read back in /me; the cookie helpers exist but nothing calls them yet.".into() },
            Item::Tool(tool("r1", "inspect", "Read src/routes/auth.ts", "src/routes/auth.ts", "")),
            Item::Tool(tool("r2", "inspect", "Read src/routes/legacy.ts", "src/routes/legacy.ts", "")),
            Item::Tool(tool("r3", "inspect", "Search readLegacyToken", "rg readLegacyToken", "src/routes/auth.ts:2\nsrc/routes/auth.ts:9\nsrc/routes/auth.ts:15")),
            Item::Tool(Tool { changes: vec![Change { path: "src/routes/session-cookie.ts".into(), kind: "add".into(), diff: COOKIE_NEW.into() }], ..tool("c1", "change", "Create src/routes/session-cookie.ts", "", "") }),
            Item::Tool(Tool { changes: vec![Change { path: "src/routes/auth.ts".into(), kind: "update".into(), diff: COOKIE_DIFF.into() }], ..tool("c2", "change", "Edit src/routes/auth.ts", "", "") }),
            Item::Tool(tool("x1", "run", "npm test -- auth", "npm test -- auth", "\n> acme-web@1.0.0 test\n> vitest run auth\n\n ✓ routes/auth.test.ts (6 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)")),
            text_item("a1", "Sign-in now writes a signed `__Host-session` cookie, and `/me` reads it back:\n\n- `src/routes/session-cookie.ts` holds `readSession` and `writeSession`.\n- `auth.ts` no longer imports the legacy reader; `/me` answers **401** when the cookie is missing.\n\nThe six auth tests pass."),
        ],
        40.0,
        Some(36.0),
        TurnState::Completed,
    );
    t.assistant = String::new();
    t
}

fn second_turn() -> Turn {
    let failing = "\n> vitest run\n\n ✓ routes/auth.test.ts (6 tests)\n ✗ routes/billing.test.ts > charges the saved card\n   AssertionError: expected 401 to be 200\n     at billing.test.ts:44:27\n\n Test Files  1 failed | 11 passed (12)\n      Tests  1 failed | 88 passed (89)";
    turn(
        "t2",
        "Run the whole suite before we ship it.",
        vec![
            Item::Plan {
                id: "p1".into(),
                steps: vec![
                    PlanStep { step: "Run the full test suite".into(), status: "completed".into() },
                    PlanStep { step: "Fix the billing test that still sends x-token".into(), status: "completed".into() },
                    PlanStep { step: "Run the suite again".into(), status: "completed".into() },
                ],
            },
            Item::Tool(Tool { exit_code: Some(1), status: "failed".into(), ..tool("x2", "run", "npm test", "npm test", failing) }),
            Item::Tool(tool("r4", "inspect", "Read src/routes/billing.test.ts", "", "")),
            Item::Tool(Tool {
                changes: vec![Change { path: "src/routes/billing.test.ts".into(), kind: "update".into(), diff: "@@ -40,7 +40,7 @@ describe(\"billing\", () => {\n   it(\"charges the saved card\", async () => {\n-    const res = await app.request(\"/charge\", { headers: { \"x-token\": token } });\n+    const res = await app.request(\"/charge\", { headers: { cookie: await signIn(app) } });\n     expect(res.status).toBe(200);\n   });\n".into() }],
                ..tool("c3", "change", "Edit src/routes/billing.test.ts", "", "")
            }),
            Item::Tool(tool("x3", "run", "npm test", "npm test", "\n Test Files  12 passed (12)\n      Tests  89 passed (89)")),
            text_item("a2", "All 89 tests pass. One billing test still signed in with the old header; it now signs in through the cookie like a browser would."),
        ],
        30.0,
        Some(27.0),
        TurnState::Completed,
    )
}

fn third_turn() -> Turn {
    turn(
        "t3",
        "Open a pull request.",
        vec![
            Item::Tool(tool(
                "x4",
                "run",
                "git push -u origin scotty/s-auth",
                "git push -u origin scotty/s-auth",
                "branch 'scotty/s-auth' set up to track 'origin/scotty/s-auth'.",
            )),
            Item::Tool(tool(
                "x5",
                "run",
                "gh pr create --fill",
                "gh pr create --fill",
                "https://github.com/acme/web/pull/512",
            )),
            text_item(
                "a3",
                "Opened [acme/web#512](https://github.com/acme/web/pull/512): *Move sign-in to the signed session cookie*. CI is running.",
            ),
        ],
        6.0,
        Some(4.0),
        TurnState::Completed,
    )
}

fn profile_turn() -> Turn {
    turn(
        "f1",
        "Search gets slow past 200 requests a second. Profile the endpoint under load and find out why.",
        vec![
            Item::Tool(tool("fr1", "inspect", "Read src/routes/search.ts", "", "")),
            Item::Tool(tool(
                "fx1",
                "run",
                "npx autocannon -c 200 -d 30 localhost:8787/search?q=shoe",
                "npx autocannon -c 200 -d 30 localhost:8787/search?q=shoe",
                "Latency p50 41 ms, p99 1,870 ms\n 6k requests in 30s",
            )),
            text_item(
                "fa1",
                "Under load the p99 climbs to 1.9 s while p50 stays at 41 ms. Every request rebuilds the synonym table; next I'll capture a profile to confirm.",
            ),
        ],
        60.0 * 30.0 + 12.0,
        Some(60.0 * 30.0 + 4.0),
        TurnState::Completed,
    )
}

fn live_first() -> Turn {
    turn(
        "l1",
        "Uploads fail for good when S3 returns a 503. Add retry with backoff to the uploads queue.",
        vec![
            Item::Tool(tool("lr1", "inspect", "Read src/queue/uploads.ts", "", "")),
            Item::Tool(tool("lr2", "inspect", "Search putObject", "", "")),
            text_item(
                "la1",
                "The queue calls `putObject` once and drops the job on any error. I'll wrap it in a retry with jittered exponential backoff, capped at five tries.",
            ),
        ],
        9.0,
        Some(8.0),
        TurnState::Completed,
    )
}

fn live_turn() -> Turn {
    let mut running = tool(
        "lx2",
        "run",
        "npm test -- uploads",
        "npm test -- uploads",
        "",
    );
    running.status = "running".into();
    running.exit_code = None;
    turn(
        "l2",
        "Go ahead.",
        vec![
            Item::Thinking { id: "lh1".into(), text: "**Choosing the backoff** Base 200ms, factor 2, full jitter, five attempts; only 5xx and network errors retry.".into() },
            Item::Plan {
                id: "lp1".into(),
                steps: vec![
                    PlanStep { step: "Add a retry helper with jittered backoff".into(), status: "completed".into() },
                    PlanStep { step: "Use it in the uploads worker".into(), status: "completed".into() },
                    PlanStep { step: "Cover 503 and timeout in tests".into(), status: "inProgress".into() },
                ],
            },
            Item::Tool(Tool {
                changes: vec![Change { path: "src/queue/retry.ts".into(), kind: "add".into(), diff: "export async function retry<T>(run: () => Promise<T>, tries = 5): Promise<T> {\n  for (let i = 1; ; i++) {\n    try {\n      return await run();\n    } catch (e) {\n      if (i >= tries || !retriable(e)) throw e;\n      await sleep(Math.random() * 200 * 2 ** i);\n    }\n  }\n}\n".into() }],
                ..tool("lc1", "change", "Create src/queue/retry.ts", "", "")
            }),
            Item::Tool(Tool {
                changes: vec![Change { path: "src/queue/uploads.ts".into(), kind: "update".into(), diff: "@@ -12,5 +12,5 @@ export async function upload(job: Job) {\n   const body = await read(job.path);\n-  await s3.putObject({ Bucket, Key: job.key, Body: body });\n+  await retry(() => s3.putObject({ Bucket, Key: job.key, Body: body }));\n   await done(job);\n }\n".into() }],
                ..tool("lc2", "change", "Edit src/queue/uploads.ts", "", "")
            }),
            Item::Tool(running),
        ],
        2.0,
        None,
        TurnState::Streaming,
    )
}
