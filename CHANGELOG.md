# Changelog

User-facing changes are recorded here before release. When cutting a release, move
Unreleased entries under the version and release date, and use them as the GitHub
release notes. Keep internal refactors and routine maintenance out unless they
change behavior users need to know about.

## Unreleased

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
