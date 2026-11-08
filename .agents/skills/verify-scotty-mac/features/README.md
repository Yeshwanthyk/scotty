# Scotty Mac features

Baseline: `launch.sh` printed a run folder and `doctor.sh` passed on it. Drive, evidence and cleanup
conventions: [SKILL.md](../SKILL.md). `ax` is `work/verify-mac/ax $APP_PID`; `$SESSION` is the
seeded session that waits for input.

| Recipe                | User-visible outcome                                                          | Behaviours |
| --------------------- | ----------------------------------------------------------------------------- | ---------- |
| [steer](steer.md)     | Opening a session shows its thread; a typed message steers it into a new turn | T1–T4      |
| [list](list.md)       | The sidebar lists sessions by day, filters by chip and updates by push        | L1–L4      |
| [tabs](tabs.md)       | Sessions open as tabs that switch by click and ⌘1–9 and close with ⌘W         | B1–B3      |
| [palette](palette.md) | ⌘K finds sessions and actions                                                 | P1–P2      |
| [servers](servers.md) | The app remembers servers, switches between them, and signs in to Access ones | S1–S4      |

Not covered yet: the Changes panel, Settings (Instructions, repository size, sign out), the
new-session sheet, Resume, the session menu (stop, delete). Proved on 2026-11-07: [steer](steer.md)
T1–T4.
