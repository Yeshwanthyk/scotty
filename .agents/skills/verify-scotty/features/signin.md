# Sign in to ChatGPT, GitHub and Claude

The stage holds the owner's ChatGPT sign-in and GitHub token, so Codex can answer and push without
a real token in the container.

## Behaviours

- **S1** `login chatgpt` prints a verification URL and code (stderr) and waits.
- **S2** After the owner approves, `login chatgpt` exits 0 with `status: "signed-in"` and an expiry.
- **S3** `doctor` then reports ChatGPT `ok`.
- **S4** `gh auth token | scotty login github` exits 0; the token is read from stdin, never
  from an argument.
- **S5** `doctor` shows both as signed in, with no token field.
- **S6** `scotty login claude` from a terminal runs `claude setup-token`; after the owner signs
  in, it exits 0 with `status: "signed-in"` and `expiresAt`. With stdin not a terminal it reads the
  token from stdin instead.
- **S7** `doctor` then reports `claude: "ok"` and `claudeExpiresAt`.

## Entry points

- CLI `scotty login chatgpt`, `scotty login github` (stdin), `scotty login claude` (TTY or stdin), `scotty doctor`. (The temporary API behind it is `POST /api/credentials/chatgpt/{start,poll}`.)

## Drive

1. `npm run --silent scotty -- login chatgpt > $EVIDENCE/01-signin.json`. Relay the URL and code from
   stderr to the owner; the owner approves at the URL. Expect exit 0 and `signed-in` (S1, S2).
2. `npm run --silent scotty -- doctor > $EVIDENCE/02-doctor.json`, expect ChatGPT `ok` (S3).
3. `gh auth token | npm run --silent scotty -- login github > $EVIDENCE/03-github.json`:
   exit 0 (S4). Never echo the token or pass it as an argument.
4. `npm run --silent scotty -- doctor --json > $EVIDENCE/04-status.json`: both signed in (S5).
5. The owner runs `npm run --silent scotty -- login claude > $EVIDENCE/05-claude.json` in a
   terminal and signs in (S6). An agent without a TTY pipes a token file the owner made instead.
6. `npm run --silent scotty -- doctor > $EVIDENCE/06-doctor.json`: `claude` `ok` (S7).

## Proof

`01-signin.json` with `signed-in`, `02-doctor.json` with ChatGPT `ok`, `03-github.json` and
`04-status.json` signed in. No token fields in any of them.

## Gotchas

- The code expires after 15 minutes; a stale code fails with `expired`. Start again.
- An agent cannot approve the code. Wait for the owner.
- Never print the Claude token; `claude setup-token` output goes to stderr for the owner only.
