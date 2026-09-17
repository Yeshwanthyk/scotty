# Session image attachments

The composer and session creation form accept up to four PNG, JPEG, WebP, or GIF images totaling 5 MiB. Both use one picker with native desktop/mobile selection, paste/drop, removable thumbnails, visible validation, and retained drafts on failed delivery. Image-only drafts supply a short review prompt because existing agent admission requires nonempty text.

## Contract and ownership

Existing create and steer HTTP requests gain optional `images: PiConsoleImage[]`. The existing Pi image schema owns MIME, base64, count, and aggregate size validation. Text-only request and response shapes remain compatible. No upload URL, external image host, browser persistence, or credential path is introduced.

- Create: form → `/api/sessions` → validated create input and idempotency digest → Session-owned private metadata → Pi seed or Codex `/prompt` → native image input.
- Composer: form → `/api/sessions/:id/steer` → Session control → Pi prompt intent or Codex `/message` → native image input.
- Queue: Session persists image content and its digest before acknowledgement; alarms dispatch under existing readiness fences. Confirmed receipts retain the digest, removing image bytes. Retry identity includes images. Pending images share a 5 MiB queue budget.
- Storage: metadata and queues use the existing Session Durable Object. A bounded transactional chunk adapter preserves legacy inline records and prevents normal photographs from exceeding the provider's per-value limit. Reads, replacement, shrinking, and deletion are atomic; corrupt/missing chunks fail.
- Resume and deletion: existing metadata/queue lifecycle remains authoritative. Pending queue images survive eviction/sleep. Existing metadata/queue deletion also removes chunks.

Inline bounded image data reuses existing native transports and avoids a second upload/asset lifecycle. Container-only uploads were rejected because they would lose authoritative ownership during create/retry and eviction. Images are never placed in KV list projections or application logs. Pi startup image seed files are removed after admission. Codex native requests use `{ type: "image", url: "data:<mime>;base64,..." }`, confirmed against pinned rust-v0.154.0 TurnStartParams schema.

## Verification

Tests cover client limits and request serialization, create idempotency, metadata immutability/scrubbing, chunk storage under an enforced 128 KiB limit, queue replay/content conflicts and byte reclamation, native Codex start/steer input, and Pi startup RPC. Browser checks exercise mobile and desktop selection, previews, removal, paste/drop, image-only drafts, and failure retention.

Local transport and browser proof does not certify deployed provider behavior. No deployment is part of this change. HEIC is not accepted; the picker explains how to export it as JPEG.

## Local result (2026-09-17)

Formatting, lint, all typechecks, production UI build, and compiled CLI pass. Image-specific tests and the full public create/steer integration pass. Direct Chromium checks pass at desktop and 390px phone width. The Scotty recording tool could not complete because of preview listener/route assertion failures; direct browser interaction and screenshots supplied the visual check.

The broader test run passed after updating the optional-argument assertion and rerunning permission-sensitive tests with `umask 022`, except five existing Codex process-cleanup tests. All five reproduce in an isolated worktree at unchanged HEAD. The secret scan also reports unchanged test fixtures. These failures remain outside this feature; no deployed proof is claimed.
