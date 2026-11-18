# Mac app performance

[strobe](https://github.com/anomalyco/strobe) measures the release app from outside, through the
macOS accessibility tree, against the UI's seed server. `../strobe.json` says how to build the app
and launch it. `scotty-mac.bench.ts` says what to measure.

| Case            | Primary           | What it measures                                  |
| --------------- | ----------------- | ------------------------------------------------- |
| `launch`        | `launch.ready`    | spawn to the seeded list on screen                |
| `idle`          | `cpu.wakes`       | five seconds open on a list with working sessions |
| `open-session`  | `interaction.p95` | a row click to its thread                         |
| `palette`       | `interaction.p95` | ⌘K, then typing a query                           |
| `switch-tabs`   | `ui.cpu`          | cycling three open tabs with ⇧⌘]                  |
| `scroll-thread` | `ui.cpu`          | scrolling the longest thread up and down          |

## Run

Needs strobe 0.19 or later (`strobe update`), the Accessibility permission for the terminal, and
an idle Mac: on macOS strobe measures only while the app is frontmost, and brings it to the front
only after a minute with no keyboard or mouse input. Runs while someone uses the Mac are thrown
away ("another app came in front").

```sh
cd mac
strobe bench perf/scotty-mac.bench.ts --head . --check        # does every case run? one pass each
strobe bench perf/scotty-mac.bench.ts --base origin/main --head .   # head against main
strobe bench --stop / --resume <exp>                          # pause, then pick up where it left off
```

The bench builds each side with `cargo build --release` into strobe's cache (`strobe.json`), so
the base and head never share a target directory.

## Hillclimb

1. Pick one case and its primary. Run `--check`, then a baseline: `--base origin/main --head .`.
2. Change one thing. Rerun the same command, and read `strobe query <exp> progress` for the
   interval, not the point estimate.
3. Keep the change only if the interval clears zero in the right direction and no other case got
   worse. Otherwise revert it.
4. Repeat from 2.

Every performance claim in a PR comes from `strobe report experiment <exp> --format pr`, pasted as
printed.

## Seed

Each block starts its own seed (`fixture` in the bench) on a free port. The app reads it from a
`servers.json` strobe writes into the app's own home. Seeded sessions and their ids are in
`ui/seed/dummy.ts`.

## Gotchas

- **Spinners keep the app from going idle.** Every case's setup waits for 300 ms with no frames
  (`page.idle()`). The seed has sessions that are working, and their spinners draw every frame, so
  all cases end `RunIncomplete` ("the app never went quiet for 300 ms"). That is a real finding: an
  open window with a working session never stops drawing. Until spinners redraw only on a tick, no
  case can pass against this seed.
- **strobe reuses a stale build when `mac/` is untracked.** Its build cache is keyed on the files git
  tracks, so edits under an untracked `mac/` print "unchanged, reusing". Delete
  `~/.local/share/strobe/builds/out/<key>` (the key is in the run's output), or commit first.
