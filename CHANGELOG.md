# Changelog

User-facing changes are recorded here before release. When cutting a release, move
Unreleased entries under the version and release date, and use them as the GitHub
release notes. Keep internal refactors and routine maintenance out unless they
change behavior users need to know about.

## Unreleased

## 0.3.30 — 2026-09-24

### Fixed

- Creating a session no longer fails with a runtime CLI lookup error when
  GitHub rate-limits release lookups. Scotty uses the last verified runtime CLI
  and reuses a recent verification for 10 minutes instead of checking GitHub on
  every session start.

## 0.3.29 — 2026-09-24

### Changed

- Checkpoint, sleep, and resume requests return HTTP 202 with the session view
  and `pending: true` while the operation is still running, instead of an
  "outcome is being reconciled" error. HTTP 200 means the session reached the
  target state. The CLI waits for the operation to finish and keeps its exit
  codes.
- When a session reaches its hard-cap drain window while the agent is mid-turn,
  Scotty waits for the turn to finish before sleeping, up to a force point
  shortly before the cap.

### Fixed

- Sessions no longer stay awake after their hard cap: cap, drain, and
  transition alarms that fire slightly early are rescheduled instead of lost,
  and a stalled transition is driven again once it is overdue.
- Sleeping a session that was resumed earlier no longer fails at the backup
  step.
- Sleeping a busy session stops processes still writing the workspace before
  the backup, and backups are bounded by the operation's remaining time instead
  of hanging until the deadline.

## 0.3.28 — 2026-09-24

### Added

- Claude Code is available as a cloud agent next to Pi and Codex. Add a Claude
  credential with `scotty sync --claude-token-file <path>` and pick the agent and
  its model in settings or with `--agent claude`.

### Changed

- Model credentials are independent per provider. An installation can hold an
  OpenAI credential, a Claude credential, or both; a session needs only the
  credential for its own agent.

## 0.3.27 — 2026-09-22

### Fixed

- Confirmed session lifecycle completion takes precedence over failed or
  ambiguous action HTTP responses, clearing stale action errors once the
  resulting session state is verified.

## 0.3.26 — 2026-09-22

### Fixed

- Published CLI builds include the generated StyleX stylesheet, restoring the
  intended layout and visual styling in deployed web installations.

### Added

- The production UI build check verifies that generated StyleX rules are present
  in the bundled stylesheet before release.

## 0.3.25 — 2026-09-22

### Improved

- Session navigation updates after creation and lifecycle changes without a manual
  refresh, retains the last verified list during temporary connection failures,
  and prevents older responses from replacing newer session state.
- Session search matches words across titles, repositories and branches, ranks
  relevant results, and improves keyboard navigation and mobile access.
- Mobile navigation keeps focus inside the open drawer. The conversation composer
  expands while typing and keeps the selected agent and model visible.
- Settings has a mobile section picker, clearer save feedback, and a resource
  editor with clickable rows, file editing, review, and confirmed removal.
- Terminal code loads on demand, unchanged Markdown avoids repeated parsing, and
  conversation and Summary polling pause while the page is hidden.
  ([#268](https://github.com/Yeshwanthyk/scotty/pull/268))

### Clarified

- Each CLI release embeds its web UI. `scotty init` deploys that UI for new
  installations; existing installations use `scotty upgrade` followed by
  `scotty deploy`. Upgrading the executable alone does not update the hosted UI.

Upgrading from before 0.3.24 also includes its settings-store change below.

## 0.3.24 — 2026-09-22

### Added

- Set custom agent instructions in web Settings for new Pi and Codex sessions.
  Each session saves the combined Scotty base and owner instructions at creation
  and reloads the same text after restart or resume. The editor shows installed
  skill names and the read-only base instructions.
  ([#266](https://github.com/Yeshwanthyk/scotty/pull/266))

### Changed

- Breaking settings update: this release starts a new settings authority record
  with default settings and an empty active resource catalog. Before upgrading,
  remove existing sessions and back up resources for re-publication. There is no
  automatic migration. Credentials, repository registrations, and stored bundle
  objects are retained; older settings records are not deleted.

## 0.3.23 — 2026-09-21

### Added

- Manage individual cloud resources from the CLI with `scotty resources list`,
  `scotty resources put <kind> <local-path>`, and
  `scotty resources remove <kind> <name>`. Supports skills, standalone Pi
  extensions, tools, and local Pi packages, including package dependency
  preparation. Updating or removing one resource preserves the rest of the cloud
  catalog. Changes apply to new sessions; existing sessions keep their pinned
  configuration. ([#263](https://github.com/Yeshwanthyk/scotty/pull/263))

### Clarified

- `scotty sandbox push` help now explicitly describes whole-catalog replacement;
  omitted resources are not retained. Its behavior is unchanged.
- Shortened the README and moved setup, CLI, feature, and architecture guidance
  into focused documentation.

## 0.3.22

Earlier releases did not maintain this file. See the
[GitHub release notes](https://github.com/Yeshwanthyk/scotty/releases/tag/v0.3.22)
for this release.
