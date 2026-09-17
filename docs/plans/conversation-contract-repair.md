# Conversation contract repair

This lane removes display-era limits from the canonical conversation path while retaining identifiers, state enums, sequence ordering, queue capacity, credential sanitization, and archive path safety.

## Slice evidence

- `337551f` shared canonical decoder. The browser consumes the protocol decoder used to validate producer output. Coverage includes 101 turns, 53 tools, multibyte UTF-8 content, exact-key rejection, invalid states, and invalid sequence ordering.
- `f0d4793` conversation admission. Browser creation/composer, CLI steer, Worker create/steer, Session metadata, and Pi command decoding accept full non-empty text. The 8 MiB Pi command envelope remains a native transport resource bound; messages beyond the former 16 KiB display budget are covered end to end through command normalization.
- `8de2a14` full projection and UI access. The Pi-to-canonical mapper no longer adds turn, tool, text, or tool-value clipping; producer-reported truncation remains visible in the snapshot and produces a UI warning. Every queued item is rendered in a scrollable list, and polled streaming text renders immediately without the synthetic two-character timer.
- `81df38a` operational capture and clients. Rollout capture streams archives and members to mode-0600 files while validating every unique archive path, without archive/member/listing display caps. CLI responses and canary peer messages no longer inherit content-size gates. Tests cover a 20+ MiB archive, a 64+ KiB listing with 300 members, and a CLI response beyond 64 MiB.
- `bc42d88` runtime-specific diagnostics and documentation. CLI Pi fallback schema names are explicit, malformed inspect output names the runtime-neutral contract, and deployment readiness identifies the selected agent runtime without probing Pi for Codex sessions. Stale bounded-content and 96 KiB admission claims are removed.
- `0a8e26d` deployment compatibility repair. Readiness retains the required public `pi` field and old readiness reasons while making selected-agent diagnostics additive and optional. Protocol, CLI, and route tests cover old and new Worker responses, including upgrade readiness for an already sleeping session.
- `ec8a4c4` rollout capture settlement. Extraction observes the output pipeline and `tar` settlement concurrently, then retains kill, wait, and unlink cleanup. Regressions cover a failing child and a failing destination stream.
- `4a96d5c` structured conversation sanitization. Nested tool strings and keys are sanitized before JSON encoding, preserving text after managed handles containing newlines and removing terminal controls without restoring display clipping.
- `224f684` tool invocation disclosure. The compact summary remains scannable while the disclosure contains the complete wrapping, horizontally scrollable invocation. Unused streaming animation props and the production-unused slicing helper are removed.
- `3bc4ce1` verification guidance. The Codex verification skill removes the stale 1,200-byte canonical cap and retains the actual bounded Pi producer behavior without claiming unlimited native retention.

## Final local verification

- `npm run fmt`
- `npm run lint:skills`
- `npm run lint`
- `npm run typecheck`
- `npm run test:all`
- `node e2e/scripts/scan.mjs`
- `bun build cli/scotty.ts --compile --outfile /tmp/scotty-cli`

All passed. `npm run test:all` ran 1,700 tests: 1,677 passed and 23 environment-dependent tests were skipped, counting the 97 Bun CLI tests emitted on stderr. Focused readiness (133), rollout capture (4), conversation mapper (8), and UI conversation/domain (8) tests also passed. The focused UI Vitest process reported its existing 10-second close timeout after reporting all tests successful. No deployed canary, live runtime, push, or deployment was exercised.

## Remaining platform constraints

- Queue admission remains bounded at 100 items per mode because it controls durable pending work, not transcript display.
- Canonical identifiers remain non-empty and bounded to 256 UTF-8 bytes; runtime failure codes/diagnostics and elapsed time retain their protocol bounds.
- Pi command envelopes remain bounded to 8 MiB, including JSON and image data. This is a native process transport resource bound, not a text-field admission policy.
- Pi snapshots retain their producer resource envelope (2 MiB response, 500 messages, 100 active tools, and bounded extension UI collections). Any producer omission is carried through `truncated` and shown in the browser; canonical decoding and projection add no second content cap.
- Cloudflare/provider request limits, local memory/filesystem capacity, and native process argument limits still apply. Codex's 16 KiB process argument check covers launch configuration only; conversation text travels over framed stdin or authenticated HTTP.

No deployment, push, or live-session mutation is part of this work. Local and synthetic checks are not live proof.
