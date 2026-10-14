# Skills from repositories

The owner adds a GitHub repository's skills, turns each on or off, and refreshes by hand; sessions
get the folder whole, with switched-off skills hidden.

## Behaviours

- **SK1** `skills add <source>` lists every skill in the folder as new, all off; `skills ls`
  shows the source, its commit and "0 of N on". A folder without a valid `SKILL.md` is listed as
  skipped.
- **SK2** `skills refresh` at the same commit reports no changes; after a push to the source it
  names what was added, updated and removed, and an updated skill keeps its switch.
- **SK3** A second source holding a skill name already taken is refused with 409 naming the
  skill and its source.
- **SK4** A new session with one skill on gets that source's whole folder in the agent's skills
  folder: links between skills resolve and scripts keep their execute bit. A source with no skill
  on isn't installed; a resume picks up switches.
- **SK5** With `--real`, a switched-off skill in an installed source doesn't show in the agent's
  skill list (Codex `[[skills.config]] enabled = false`, Claude `skillOverrides`).
- **SK6** Settings → Skills: a fold per source with "N of M"; refresh slides in new rows and
  flashes updated ones, or says "Up to date"; a pasted GitHub link flashes the field.

## Entry points

- CLI `scotty skills add|ls|on|off|refresh|rm`. e2e: `npm run --silent e2e -- settings` (SK1,
  SK2 at the same commit, SK4) on `Yeshwanthyk/agent-skills/skills` and `Yeshwanthyk/scotty/skills`. Browser at 390×844 and desktop width, light and dark, for
  SK6; `npm run ui:dev` seeds sources and serves refresh.

## Drive

1. `skills add Yeshwanthyk/agent-skills/skills --json` into `01-add.json`: `added` lists every
   skill, `yesh-router` and `plan` among them (SK1). `skills ls --json` into `02-ls.json`: all off.
2. `skills refresh Yeshwanthyk/agent-skills/skills --json` into `03-refresh.json`: empty `added`,
   `updated` and `removed` (SK2).
3. Add a second source holding a name already taken, such as a fork of agent-skills
   (`skills add <you>/agent-skills/skills`): exit 1, the message names the skill and
   `Yeshwanthyk/agent-skills/skills` (SK3).
4. `skills on yesh-router`, then a [core-loop](core-loop.md) session asked to run
   `ls ~/.agents/skills; test -x ~/.agents/skills/yesh-router/references/decision-trail/log.sh && echo ok`:
   every agent-skills folder is listed and `ok` prints (SK4).
5. With `--real` and a Codex session, ask it to list its skills: `plan` is absent though its
   folder is installed (SK5). Repeat with `--agent claude`.
6. Open `/settings/skills`, refresh, paste a github.com tree link into Add; screenshot each (SK6).
7. Put the owner's sources and switches back as `02-ls.json` had them before step 1.

## Gotchas

- The scripted agents ignore skill settings, so only `--real` proves SK5.
- Add and refresh need the GitHub token (`scotty login github`); a private repository needs the
  token to reach it.
- Running sessions keep the skills they started with.
