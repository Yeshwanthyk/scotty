# Scotty features

Baseline: a deployed stage, `SCOTTY_URL` set, `scotty doctor` exits 0, a fresh `$EVIDENCE`
directory. Conventions, evidence and cleanup: [SKILL.md](../SKILL.md).

| Recipe                            | User-visible outcome                                                                           | Behaviours | e2e                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ---------- | -------------------- |
| [signin](signin.md)               | ChatGPT and GitHub are connected so Codex can answer and push                                  | S1–S5      | none                 |
| [core-loop](core-loop.md)         | A session on a public repo answers, takes a steer and stops on interrupt                       | C1–C5      | `core`               |
| [redeploy](redeploy.md)           | A session survives a Worker redeploy with no lost or duplicated message                        | R1–R2      | `core`               |
| [stop-resume](stop-resume.md)     | A stopped session resumes with its thread and files                                            | L1–L4      | `stop-resume`        |
| [lifecycle](lifecycle.md)         | A quiet turn keeps running; an idle session sleeps, frees its container and wakes on a message | W1–W4      | `lifecycle`          |
| [live](live.md)                   | An open page and the session list update by push, without polling                              | V1–V5      | `live`               |
| [find](find.md)                   | Sessions are grouped, filtered and found by title, repo, prompt                                | N1–N4      | `core`               |
| [github-events](github-events.md) | Signed GitHub failures steer the PR session; retries and self-events add no turn               | Events     | `github`             |
| [github](github.md)               | A session on a private repo pushes only its own branch, and holds no token                     | G1–G3      | `github`             |
| [hatch](hatch.md)                 | A dev server in a session opens at its preview URL, and comes back on resume                   | H1–H4      | `hatch`, `hatch-env` |
| [files](files.md)                 | Images and video the agent makes show in the turn that made them                               | F1–F4      | `files`              |
| [hooks](hooks.md)                 | A signed webhook starts or steers a session and every delivery is listed                       | K1–K5      | `hooks`              |
| [signatures](signatures.md)       | Linear and Slack signatures verify; tampered and stale deliveries are listed                   | Signing    | `signatures`         |
| [reach](reach.md)                 | Agents call token and MCP services through internal URLs                                       | Transport  | `reach`              |
| [mcp-oauth](mcp-oauth.md)         | OAuth sign-in, refresh and tool policy through internal MCP URLs                               | OAuth      | `mcp-oauth`          |
| [automations](automations.md)     | A schedule or a webhook delivery fires a run into a session, or a listed skip                  | A1–A6      | `automations`        |
| [blueprints](blueprints.md)       | One install makes a use's connections and automations off, and shows what to paste where       | B1–B5      | `blueprints`         |
| [ui](ui.md)                       | The phone UI creates, answers, steers and interrupts, and shows files                          | U1–U6      | none                 |

An e2e proves the same behaviours automatically; drive the recipe when a change needs a human-
readable trail or the e2e is not enough. Not covered yet (not built): the terminal, Claude, Pi.
