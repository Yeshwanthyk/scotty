# Cloud-managed settings implementation

Branch: `kyendamuri/cloud-managed-settings`.

Cloud storage owns editable installation settings. `scotty init` establishes the
installation through a polished terminal wizard; normal use requires no TOML.
Local state retains only connection/auth references. Explicit commands publish
sandbox updates and refresh locally obtained credentials. Runtime files may
still use native agent formats, but are generated projections, not authority.

## Delivery tracker

Each slice includes CLI or browser entry, persistence, runtime effect where
applicable, and focused verification. Implementation: Sol medium. Independent
verification: Astra medium. Structure review: Sol medium using
`/Users/yesh/.gitgud/skills/yesh-structure-review/SKILL.md`. Both reviews use
applicable `.agents/skills` and the pinned `vendor/effect` patterns, source, and
tests as evidence. A slice is done only after findings are resolved.

| Slice                       | Result                                                                    | Status / proof                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1. Defaults and environment | Retained Pi/Codex profiles and app values managed in Settings             | Implemented; browser save/reload and draft retention; tests cover create/retry/resume pins                             |
| 2. Connections              | Named local Pi/Codex/GitHub credential refresh                            | Implemented; compiled CLI GitHub refresh against local Worker; preservation/version tests and Astra review             |
| 3. Repositories             | Cloud repository registry editing                                         | Implemented; browser registration and reload with GitHub verification; route tests                                     |
| 4. Skills and resources     | Cloud browse/upload/edit/remove for skills and prepared runtime resources | Implemented; browser skill create/edit/reopen and executable tool upload/reopen/remove; archive tests and Astra review |
| 5. Guided init              | Terminal setup without required TOML; retry from saved pointer            | Implemented; 120 Effect CLI and 97 Bun CLI tests; compiled CLI; Astra review                                           |
| 6. Migration and UI polish  | Explicit legacy import and sandbox publication; focused settings panes    | Implemented; obsolete CLI expectations/docs updated; local Browser journeys; repository gates passed                   |

These statuses cover code and local verification. Actual installed-image resource
execution and deployed create/resume are not proven by these checks.

## Product boundaries

- Settings navigation: Agents, Repositories, Environment, Resources, Connections.
  Use a focused settings layout with a return to sessions, compact controls,
  clear save/error states, and responsive browser verification.
- Environment variables are ordinary app configuration. Provider credentials use
  the credential vault and session-bound sentinels; reserved runtime/auth keys
  cannot override that boundary. Arbitrary secret env handling needs a distinct
  secure representation before claiming secret storage support.
- Cloud owns resource contents and agent configuration previously sourced from
  TOML. Native agent support is explicit: Pi extensions/packages are not silently
  advertised as Codex-compatible. Prepared package upload must define dependency
  handling; the Worker cannot run an npm build during a settings save.
- New sessions pin configuration and resource versions. Retry, wake, and resume
  do not silently switch to current installation defaults. Existing sessions
  without the new metadata keep the legacy recovery path.
- Local credential refresh and sandbox publication remain explicit. Direct cloud
  OAuth is a separate capability, not a promise of this migration.
- Alchemy infrastructure and deployment inputs remain distinct from editable
  runtime settings. Removing user-maintained TOML does not remove infrastructure
  code or required provider credentials.

## Verification and cleanup

- [x] Sol structure review and Astra core correctness review; confirmed findings fixed.
- [x] Applicable Effect skills and pinned source/patterns checked; lint and typechecks pass.
- [x] Normal init/deploy/beam/sync no longer read TOML implicitly or replace cloud settings.
- [x] Named credential refresh preserves unrelated entries and reuses the existing
      agent credential when switching between Pi and native Codex sources.
- [x] Explicit legacy import retained; CLI help, receipts, docs, and tests updated.
- [x] Session create/retry/resume pins covered by production-adapter tests with fake hosts.
- [x] Actual React UI exercised against persistent local Worker storage.
- [x] Formatting, skills lint, root lint/typecheck, full test suite, E2E scan, UI build,
      and standalone CLI compilation passed.
- [ ] Actual installed-image Pi/Codex resource discovery and deployed create/resume:
      not run; requires separate live runtime proof.

## Final local evidence

Local Worker: `http://127.0.0.1:8791`, using persistent local Durable Objects and R2,
normal owner browser registration, and no mock settings API. Containers disabled.
The earlier port-4187 prototype is superseded.

Browser journeys:

- Changed active agent and APP_ENV; saved, reloaded, and observed persisted values.
- Edited an environment value, changed panes, returned, saved and reloaded it.
- Ran compiled `scotty sync --github --json` against local Worker, then added
  `octocat/Hello-World` through the browser with actual GitHub repository verification.
- Created `cloud-demo` skill in the editor, reopened it, changed its text, and saved.
- Uploaded `hello-tool` through the real file chooser; executable was selected by
  default, persisted after reopening, and removal preserved the existing skill.
- Inspected the revised agent/environment/resource forms and final navigation.

Vercel's official environment settings screenshot informed label placement,
aligned fields and footer actions:
https://vercel.com/docs/environment-variables/managing-environment-variables

Final full-suite result: 157 contract, 868 Worker, 120 Effect CLI, 97 Bun CLI,
8 lab, 92 UI, 4 static E2E, 11 local helper, and 195 operations tests passed.
One Worker test and 17 operations tests were skipped. The UI suite emitted a
Vite shutdown-handle warning but exited successfully; the full command exited 0.
Subsequent UI-only heading/button polish passed UI build, typecheck and focused lint.

Astra's sole final resource finding was executable permissions on new tool uploads;
Sol fixed it, the focused test passed, Astra rechecked it, and the browser journey
confirmed it. No remaining confirmed core findings in the reviewed scope.

Limits: init credential setup is verified compositionally rather than by a fresh
real cloud deployment. A narrow viewport override did not change the in-app browser
viewport; only the actual desktop viewport was visually verified. No production
resources were deployed or changed. Changes remain uncommitted on the feature branch.
