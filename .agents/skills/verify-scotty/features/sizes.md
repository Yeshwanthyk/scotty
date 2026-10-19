# Sizes and the running cap

Sessions run under the container app's `durable_object` scheduling policy, so each start names
its image and size (every session is `standard-1` for now). Scotty caps how many run at once:
`maxRunning` in the stage config (default 20). A start over the cap stops at once with reason
`cap` and says how to make room.

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

## Entry points

- CLI `scotty doctor | new | ls | stop | resume | log | auth status`, Settings → Running. e2e:
  `npm run --silent e2e -- sizes` (Z3, Z4) against a stage deployed with `"maxRunning": 2` in its
  config. It reads the cap from `GET /api/settings`, fails on a cap over 3, and resumes the refused
  session only after the stopped one's slot is released.

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
6. Z5 has no drive step: a lost release can't be arranged from outside. Report it as not driven;
   the path is `container.start` in `src/session/object.ts`.

## Proof

`03-app.json` with `durable_object`; `01` and `04` with the same credentials; the doctor line; the
third session's `07-log.json` cap stop and its `08-log.json` answer after the resume.

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
- A start without `instance` runs as `lite`. If a session's `nproc`/`MemTotal` look small, check
  `src/places/cloudflare.ts` still passes `instance`.
