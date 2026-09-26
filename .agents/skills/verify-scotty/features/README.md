# Scotty features

Baseline: a deployed stage, `SCOTTY_URL` set, `scotty doctor` exits 0, a fresh `$EVIDENCE`
directory. Conventions, evidence and cleanup: [SKILL.md](../SKILL.md).

| Recipe                    | User-visible outcome                                                     | Behaviours |
| ------------------------- | ------------------------------------------------------------------------ | ---------- |
| [signin](signin.md)       | ChatGPT is connected so Codex can answer                                 | S1–S3      |
| [core-loop](core-loop.md) | A session on a public repo answers, takes a steer and stops on interrupt | C1–C5      |
| [redeploy](redeploy.md)   | A session survives a Worker redeploy with no lost or duplicated message  | R1–R2      |

Not covered yet (not built): GitHub push, pause and resume, vaporize, previews (Hatch), terminal,
evidence, Claude, the web UI. Add a recipe when its step lands.
