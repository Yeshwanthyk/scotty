# Sign in to ChatGPT

The stage holds the owner's ChatGPT sign-in, so Codex can answer without a key in the container.

## Behaviours

- **S1** `auth login chatgpt` prints a verification URL and code (stderr) and waits.
- **S2** After the owner approves, `auth login chatgpt` exits 0 with `status: "signed-in"` and an expiry.
- **S3** `doctor` then reports ChatGPT `ok`.

## Entry points

- CLI `scotty auth login chatgpt`; `scotty auth status` shows the result. (The temporary API behind it is `POST /api/credentials/chatgpt/{start,poll}`.)

## Drive

1. `npm run --silent scotty -- auth login chatgpt > $EVIDENCE/01-signin.json`. Relay the URL and code from
   stderr to the owner; the owner approves at the URL. Expect exit 0 and `signed-in` (S1, S2).
2. `npm run --silent scotty -- doctor > $EVIDENCE/02-doctor.json`, expect ChatGPT `ok` (S3).

## Proof

`01-signin.json` with `signed-in` and `02-doctor.json` with ChatGPT `ok`. No token fields in
either.

## Gotchas

- The code expires after 15 minutes; a stale code fails with `expired`. Start again.
- An agent cannot approve the code. Wait for the owner.
