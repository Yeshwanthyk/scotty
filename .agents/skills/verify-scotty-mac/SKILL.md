---
name: verify-scotty-mac
description: Launch, drive and prove the native macOS Scotty app (mac/) against the UI's seed API, through the macOS accessibility tree, with screenshots and a screen recording as evidence. Use after any change under mac/, before calling a Mac app change done, and to set up a strobe bench run that hillclimbs its performance.
---

# Verify Scotty Mac

The Mac app (`mac/`, Rust on Rune) talks to a Scotty Worker over HTTP and WebSockets. A run here
points it at the UI's seed server (`ui/seed`, served by Vite on loopback), which speaks the same
`/api` and sockets with seeded sessions and plays a scripted turn on every steer. Loopback has no
Cloudflare Access, so no sign-in is needed. A real deployment needs the owner's browser sign-in,
which an agent cannot do.

Every script is in `scripts/` and runs from anywhere in the checkout. A run owns one folder,
`work/verify-mac/<time>-<pid>/`, holding `run.env`, the seed and app logs, the app's private
`home/` and `evidence/`.

## Launch

```sh
run=$(.agents/skills/verify-scotty-mac/scripts/launch.sh)
```

The script:

1. builds the AX driver (`scripts/ax.swift`, compiled to `work/verify-mac/ax`) and the release app;
2. starts the seed on a free port in its own process group and waits for `/api/sessions`;
3. writes the seed into a private `$run/home/Library/Application Support/scotty-mac/servers.json`;
4. starts the app with `HOME=$run/home` and `APP_OFFLINE` unset;
5. moves the window to a spot where no other app's window covers it (`ax place`), then waits until
   the seeded row `row:$SESSION` shows.

It prints the run folder. `run.env` records `SEED_PID`, `SEED_URL`, `APP_PID`, `APP_HOME` and `RUN`.

## Doctor

```sh
.agents/skills/verify-scotty-mac/scripts/doctor.sh "$run"
```

These read-only checks must all print `ok`:

- the seed is alive and lists the seeded sessions;
- the app is alive and is this checkout's release build;
- its home opens the seed and it holds a socket to the seed;
- this shell can read the app's accessibility tree;
- the window is on screen, uncovered, and has drawn the list.

Doctor says the run is drivable, not that a feature works.

## Drive

Drive the app through `work/verify-mac/ax <pid> <verb>`. Selectors are the app's element keys
(`.key(...)` in `mac/src`), which Rune exports as accessibility identifiers.

| Verb                               | Does                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `tree`                             | prints the visible tree: role, key, name, frame                                 |
| `has <key>`                        | exits 0 when the key is in the tree                                             |
| `wait <key> [s]`, `gone <key> [s]` | waits for a key to show or go                                                   |
| `press <key>`                      | the accessibility press: a button's action, or focus for a text field           |
| `type <text>`                      | types into the focused field (`\n` is Return)                                   |
| `key cmd+shift+]`                  | one key with modifiers                                                          |
| `window`, `place`, `covered`       | the window's id and bounds; move it clear of other windows; list what covers it |
| `front`                            | activates the app (macOS may refuse while someone else is using the Mac)        |

Keys a drive uses most: `row:<id>`, `thread:<id>`, `composer:<id>`, `send`, `stop-turn`,
`sidebar-search`, `palette-input`, `sidebar-filter` (opens `filter:<name>` items), `chip:<name>` (a filter in force; pressing clears it), `stopped-toggle`, `home-repo` (opens `repo:<owner/name>` items and `repo-other`), `open-settings`, `host`,
`changes-button`, `session-menu`. `lib.sh` exports `SESSION`, a seeded session that waits for input
and shows without filters.

## Evidence

```sh
scripts/record.sh "$run" start <name>   # mp4 of the window's screen area, until stop
scripts/shot.sh "$run" <name>           # png of the window alone
scripts/record.sh "$run" stop
```

Both write to `$run/evidence/`. Capture the action and the state it led to, not only the end. Prove
side effects through the seed: `curl -s "$SEED_URL/api/sessions/<id>/log" | jq` is the session's
event log, so a steer shows as `prompt.requested` with `src: "api"` and the typed text.

## Cleanup

```sh
scripts/cleanup.sh "$run"
```

The script ends the recorder, the app and the seed by their process groups (the PIDs in `run.env`,
never by name), deletes `home/` and checks that the port is free. It keeps `evidence/`, the logs and
`run.env`. Run it after failed drives too. After a surprise, clean up, launch again and rerun doctor.

## Features

[features/README.md](features/README.md) indexes one recipe per feature.

## Performance

`mac/perf/` holds the strobe bench and how to hillclimb with it ([mac/perf/README.md](../../../mac/perf/README.md)).

## Gotchas

- **A covered window draws nothing.** Rune runs `poll` but builds no frame while another window
  covers it. The tree and screenshots then stay stale; a list that looks empty is usually this.
  `launch.sh` places the window, and doctor's `covered` check catches a later cover.
- **Accessibility permission.** The app that runs these scripts (the terminal or agent host) needs
  it in System Settings › Privacy & Security › Accessibility, or `ax` exits with "no Accessibility
  permission". Recording needs Screen Recording for the same app.
- **`APP_OFFLINE` set at all, even empty, means offline.** The app then shows a scene, not a server.
  The scripts use `env -u APP_OFFLINE`.
- **The tree holds only what is drawn.** A stopped session's row shows only after
  `stopped-toggle`; a closed menu's items aren't there.
- **Several runs at once are safe** (own port, home and folder), but each window needs its own
  uncovered spot, and `type`/`key` go to one pid at a time.
- **Offline scenes** need no server: `APP_OFFLINE=1 mac/target/release/scotty-mac --scene <name>
--snap out.png --tree tree.json` renders a scene headless with its accessibility tree.
