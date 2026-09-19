# Assistant image delivery proof

The original Markdown renderer deliberately emitted image tokens as text. The reported
`/workspace/.../after-table-detail.png` destination also had no browser delivery route. The
workspace changes API exposes metadata and bounded Git patches, not arbitrary file bytes.

The fix accepts `![Description](scotty-evidence:<jobId>)`. It selects the first persisted frame
from the current session's evidence summary. Conversation (including streaming and folded turns)
and Summary pass that session-bound metadata to Markdown. Assistant references now trigger
an evidence read even when their tool output is absent from the transcript. An evidence-read
failure shows unavailable feedback while the existing retry continues.

The image request uses the existing registered-browser frame route. The Worker still checks the
browser cookie and read scope, resolves the artifact through the session Sandbox DO, and checks
R2 owner/job/frame metadata before serving a private, no-store PNG with `nosniff`. There is no new
HTTP route or file reader. Raw HTML remains inert. External URLs, data URLs, filesystem paths,
traversal, and direct route strings cannot become Markdown image sources.

## Browser checks

`e2e/scripts/assistant-images.mjs` drives the real Vite app with seeded HTTP responses and PNG
bytes. It uses a non-fixture session route, so the production session/snapshot decoders, live
conversation evidence hook, Markdown renderer, and Summary all execute. It does not require or
write real credentials or session state. The screenshot within the seeded response is a generated
table fixture generated at runtime (`work/assistant-images/seed.png` by default).

The seeded message flow and route were checked at 1280×800 and 390×844:

1. Original Markdown renderer: literal image syntax, zero assistant images.
2. Patched renderer: one accessible image with nonzero natural width, no viewport overflow;
   expired and missing images show unavailable text.
3. No requests for the workspace path, external tracker, or raw HTML image. Summary also loads
   the published image. Production route tests separately verify authorization, missing ownership,
   malformed paths, response headers, and delivered PNG bytes.

Run against an already-running local UI, with an installed Playwright module and browser:

```sh
TMPDIR=/tmp \
SCOTTY_PLAYWRIGHT_MODULE=/opt/scotty/pi-packages/sources/scotty-browser-test/node_modules/playwright-core/index.mjs \
SCOTTY_BROWSER_EXECUTABLE=/opt/scotty/playwright-browsers/chromium-1234/chrome-linux64/chrome \
node e2e/scripts/assistant-images.mjs
```

The module/browser overrides are optional when Playwright and its browser are installed normally.
`SCOTTY_UI_ORIGIN` selects the local UI; output defaults to `work/assistant-images`.
Run `--before` with the original Markdown renderer to assert the failing behavior.

Screenshots and the generated seed image stay in the ignored output directory; no PNG artifacts
are committed to the repository. Run the driver to reproduce the captures locally.

## Proof limits

These are direct Chromium captures of the real UI with seeded API responses. They prove rendering
and client wiring, not deployed authorization or lifecycle. The first-party evidence run stopped
before any frame with `port_conflict`; the app was not restarted or reconfigured. No successful
chat-deliverable evidence job or after video is claimed. The local lab could not start or complete
cleanup because Docker is absent (its process is missing and its manifest is cleanup-pending).

The security scanner flags 13 unchanged fixture files because the inherited GitHub credential is
a managed sentinel also present in those fixtures; zero matching files changed in this patch.
The token-file permission suite needs umask `0022`: under this session's `0077`, its intentionally
public file is created private. The focused suite passes with `0022`. The full gate was also attempted: one run reached
979 passing Worker tests with only that permission fixture failing; later reruns hit an unchanged
bundling test's five-second timeout under concurrent load, then exited 143 during the Worker phase
when run sequentially. A full green gate is not claimed. The remaining checks passed: 124 CLI Effect tests, 97 CLI
tests (umask `0022`), 15 lab unit tests, 135 UI tests, and 14 static/helper tests. Operations tests
reported 196 passes, 22 skips, and eight failures: three from an unchanged browser-package source
digest mismatch and five from supervisor fixture timeouts. The package sources, pins, and
supervisor tests are unchanged by this PR.

PR #256 owns table/Mermaid rendering. This patch adds only inline image rendering and keeps those
technical-block/layout changes separate. A temporary checkout of commit `0120740` plus this patch
merged cleanly and passed all 138 combined UI tests and the UI typecheck.
