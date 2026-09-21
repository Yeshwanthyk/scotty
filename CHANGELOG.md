# Changelog

User-facing changes are recorded here before release. When cutting a release, move
Unreleased entries under the version and release date, and use them as the GitHub
release notes. Keep internal refactors and routine maintenance out unless they
change behavior users need to know about.

## Unreleased

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
