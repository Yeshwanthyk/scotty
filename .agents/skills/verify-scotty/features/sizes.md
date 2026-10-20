# Sizes and the running cap

Sessions run under the container app's `durable_object` scheduling policy, so each start names
its image and size. A session's size is `standard-1` unless its create (API, MCP, `scotty new
--size`, hook payload) or its automation names `standard-2`, `standard-3` or `standard-4`. A
stopped session can resume at another size (`scotty resume <id> --size`); a running one can't.
Scotty caps how many run at once: `maxRunning` in the stage config (default 20). A start over the
cap stops at once with reason `cap` and says how to make room.

## Behaviours

- **Z1** The Cloudflare API shows the stage's session app, `scotty-<stage>-sessions`, with
  `scheduling_policy: durable_object`. `auth status` shows every credential it showed before the
  deploy that switched the app.
- **Z2** `doctor` reports `<running> of <maxRunning> running` on the Worker line. Settings → Running
  shows the same.
- **Z3** With the cap full, a new session is `stopped · cap: <max> sessions are running; stop one or
raise maxRunning`. Its log has `container.stopped {reason: "cap", max}` and no `sup.hello`, so no
  container started.
- **Z4** After one running session stops, the refused session resumes and answers.
- **Z5** A slot whose release was lost is reclaimed: when the cap is full, a claimed session that
  no longer runs loses its slot, and the start goes ahead.
- **Z6** A session started with `--size standard-3` shows `standard-3` in `read --json`, `ls --json`
  and the page header, and reads `standard-3`'s row of the table in design.md (Containers): `nproc`
  exactly, `MemTotal` within 5%. One started with no size is `standard-1` and reads its row. After
  a stop and a resume, the `standard-3` session reads the same again.
- **Z7** `lite`, `basic` and `standard-9` are refused: the API answers 400 naming `["size"]`, MCP
  `new_session` answers a tool error naming it, and `scotty new --size` exits 2 with a `usage` error
  naming `--size` (JSON on stdout when piped). No session is made. `scotty new --size standard-2`
  makes a session whose `read --json` shows `standard-2`.
- **Z8** An automation with `size: standard-2` starts sessions whose `read` shows `standard-2` and
  that read `standard-2`'s row.
- **Z9** An automation at `standard-2` with `action: wake` reaches a `standard-1` session by its
  key: the run is `steered`, and the session stays `standard-1`. A size applies only when a session
  is made.
- **Z10** A scripted `standard-1` session writes `kept.txt` and stops. `POST …/resume
{size: "standard-3"}` resumes it: `read --json` and the header show `standard-3`, it reads
  `standard-3`'s row, and `cat kept.txt` says `kept`. While it runs, a resume naming another size
  is refused and nothing is appended: the API answers 409 `{code: "running", hint: "scotty stop
<id>"}`, MCP `resume_session` a tool error, `scotty resume --size` exit 1 with code `running`. A
  later resume with no size stays `standard-3`; `scotty resume <id> --size standard-2` on the
  stopped session makes it `standard-2`.

## Entry points

- CLI `scotty doctor | new | ls | stop | resume | log | auth status`, Settings → Running. e2e:
  `npm run --silent e2e -- sizes` (Z3, Z4, Z6–Z10) against a stage deployed with
  `"maxRunning": 2` in its config. It reads the cap from `GET /api/settings`, fails on a cap over
  3, and resumes the refused session only after the stopped one's slot is released. The size checks
  run one session at a time, waiting for a free slot.

## Drive

1. `auth status > $EVIDENCE/01-auth-before.json`. Set `"maxRunning": 2` in the stage's config,
   deploy, and save the deploy's output as `02-deploy.log`. The first deploy after this change
   says "Replacing the container app".
2. Read the app:
   `curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/accounts/<account>/containers/applications | jq '.result[] | select(.name == "scotty-<stage>-sessions") | {name, scheduling_policy, durable_objects}' > $EVIDENCE/03-app.json`
   (Z1). `auth status > 04-auth-after.json`; it matches `01` (Z1).
3. `doctor > 05-doctor.txt` (Z2).
4. Make sure nothing else runs (`ls`), then start two scripted sessions on `_scotty/fixture` and
   wait for each to answer. Start a third; `ls > 06-ls.txt` shows it stopped with the cap message,
   and `log <third> > 07-log.json` has the cap stop and no `sup.hello` (Z3).
5. `stop <first>`, `resume <third>`, read until it answers; `log <third> > 08-log.json` (Z4).
6. `new _scotty/fixture "Run nproc; grep MemTotal /proc/meminfo" --size standard-3`, and one with no
   `--size`; `read <id> --json > 09-read-<size>.json` each once answered (Z6). `stop`, `steer` it the
   same prompt, `read` again (Z6). `new … --size basic; echo $? > 10-cli-basic.txt` (Z7).
7. Make an automation with `"size": "standard-2"`, run it (`POST /api/automations/<name>/run`),
   `read <session> --json > 11-automation-read.json` (Z8). Make one with `"action": "wake"` and the
   `key` of a running `standard-1` session, run it; save the run as `12-wake-run.json` (Z9). Remove
   the automations and sessions.
8. Start a scripted `standard-1` session whose prompt runs `echo kept > kept.txt`. While it runs,
   `resume <id> --size standard-3; echo $? > 13-resize-running.txt` (Z10). `stop`, then
   `resume <id> --size standard-3`, `read <id> --json > 14-resized.json`, and steer it
   `run nproc; grep MemTotal /proc/meminfo` and `run cat kept.txt` (Z10). `stop`, `resume <id>`,
   `read --json > 15-resumed.json` (still `standard-3`). Screenshot the stopped banner's size
   picker beside Resume as `16-banner.png`.
9. Z5 has no drive step: a lost release can't be arranged from outside. Report it as not driven;
   the path is `container.start` in `src/session/object.ts`.

## Proof

`03-app.json` with `durable_object`; `01` and `04` with the same credentials; the doctor line; the
third session's `07-log.json` cap stop and its `08-log.json` answer after the resume; the `size`
and readings in `09-*`, exit 2 in `10-*`, `standard-2` in `11-*`, `steered` in `12-*`, exit 1 in
`13-*`, `standard-3` and `kept` in `14-*`, `standard-3` in `15-*`.

## Gotchas

- `running` counts claims in the Creds DO's `running` table, not containers. A session holds a
  claim from its start until it stops, sleeps or fails: each of those ends in `destroy`, which
  releases it.
- A cap stop with no running sessions in `ls` means stale claims that every session answered as
  running. Ask each listed session's log for its last event; a session stuck provisioning holds
  its slot until its container deadline fails it.
- If a session ends `failed` with `container_start` right after the switch, the app may not be
  bound to the SessionObject namespace: check `durable_objects.namespace_id` in `03-app.json`
  against the SessionObject id in `GET /accounts/<account>/workers/durable_objects/namespaces`.
- e2e prints each size's `nproc` and `MemTotal` and checks them against design.md's table. The
  `scotty new --size standard-2` session runs the real agent (the CLI has no scripted flag), so e2e
  only reads its size and doesn't measure it.
- A resume appends no `container.start`: only the first start is an event. A new container shows
  as a `sup.hello` with a later `gen`.
- An automation run keeps the size its definition had when the run was received (`run_sizes` in
  the Creds DO).
- A resize is a stop and a resume: the size is `resume.requested.size` in the log, and the new
  container's `sup.hello` has the next `gen`. The UI's size picker sits in the stopped banner, not
  the menu; the menu's Resume keeps the size.
- A start without `instance` runs as `lite`. If a session's `nproc`/`MemTotal` look small, check
  `src/places/cloudflare.ts` still passes `instance`.
