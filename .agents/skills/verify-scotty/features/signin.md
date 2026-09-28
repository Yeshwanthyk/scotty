# Sign in to ChatGPT and GitHub

The stage holds the owner's ChatGPT sign-in and GitHub token, so Codex can answer and push without
a real token in the container.

## Behaviours

- **S1** `auth login chatgpt` prints a verification URL and code (stderr) and waits.
- **S2** After the owner approves, `auth login chatgpt` exits 0 with `status: "signed-in"` and an expiry.
- **S3** `doctor` then reports ChatGPT `ok`.
- **S4** `gh auth token | scotty auth login github` exits 0; the token is read from stdin, never
  from an argument.
- **S5** `auth status` shows both as signed in, with no token field.

## Entry points

- CLI `scotty auth login chatgpt`, `scotty auth login github` (stdin), `scotty auth status`. (The temporary API behind it is `POST /api/credentials/chatgpt/{start,poll}`.)

## Drive

1. `npm run --silent scotty -- auth login chatgpt > $EVIDENCE/01-signin.json`. Relay the URL and code from
   stderr to the owner; the owner approves at the URL. Expect exit 0 and `signed-in` (S1, S2).
2. `npm run --silent scotty -- doctor > $EVIDENCE/02-doctor.json`, expect ChatGPT `ok` (S3).
3. `gh auth token | npm run --silent scotty -- auth login github > $EVIDENCE/03-github.json`:
   exit 0 (S4). Never echo the token or pass it as an argument.
4. `npm run --silent scotty -- auth status > $EVIDENCE/04-status.json`: both signed in (S5).

## Proof

`01-signin.json` with `signed-in`, `02-doctor.json` with ChatGPT `ok`, `03-github.json` and
`04-status.json` signed in. No token fields in any of them.

## Gotchas

- The code expires after 15 minutes; a stale code fails with `expired`. Start again.
- An agent cannot approve the code. Wait for the owner.
