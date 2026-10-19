# Sizes and the running cap

Sessions run under the container app's `durable_object` scheduling policy, so each start names
its image and size. A session's size is `standard-1` unless its create (API, MCP, `scotty new
--size`, hook payload) or its automation names `standard-2`, `standard-3` or `standard-4`.
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
  and the page header, and `nproc` in it is 2. One started with no size is `standard-1`, `nproc` 1.
  After a stop and a resume, the `standard-3` session reads the same `nproc` and `MemTotal`.
- **Z7** `lite`, `basic` and `standard-9` are refused: the API answers 400 naming `["size"]`, MCP
  `new_session` answers a tool error naming it, and `scotty new --size` exits 2. No session is made.
- **Z8** An automation with `size: standard-2` starts sessions whose `read` shows `standard-2`.

## Entry points

- CLI `scotty doctor | new | ls | stop | resume | log | auth status`, Settings → Running. e2e:
  `npm run --silent e2e -- sizes` (Z3, Z4, Z6, Z7, Z8) against a stage deployed with
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
   `read <session> --json > 11-automation-read.json` (Z8). Remove the automation and sessions.
8. Z5 has no drive step: a lost release can't be arranged from outside. Report it as not driven;
   the path is `container.start` in `src/session/object.ts`.

## Proof

`03-app.json` with `durable_object`; `01` and `04` with the same credentials; the doctor line; the
third session's `07-log.json` cap stop and its `08-log.json` answer after the resume; the `size`
and readings in `09-*`, exit 2 in `10-*`, `standard-2` in `11-*`.

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
- e2e prints each size's `nproc` and `MemTotal`. It asserts `nproc` (1 at `standard-1`, 2 at
  `standard-3`) and that `standard-3` has more memory; once design.md has a table of readings, check
  them against it.
- An automation run keeps the size its definition had when the run was received (`run_sizes` in the Creds DO).
- A start without `instance` runs as `lite`. If a session's `nproc`/`MemTotal` look small, check
  `src/places/cloudflare.ts` still passes `instance`.
