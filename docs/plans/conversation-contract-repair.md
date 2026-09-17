# Conversation contract repair

This lane removes display-era limits from the canonical conversation path while retaining identifiers, state enums, sequence ordering, queue capacity, credential sanitization, and archive path safety.

## Slice evidence

- `337551f` shared canonical decoder. The browser consumes the protocol decoder used to validate producer output. Coverage includes 101 turns, 53 tools, multibyte UTF-8 content, exact-key rejection, invalid states, and invalid sequence ordering.
- `f0d4793` conversation admission. Browser creation/composer, CLI steer, Worker create/steer, Session metadata, and Pi command decoding accept full non-empty text. The 8 MiB Pi command envelope remains a native transport resource bound; messages beyond the former 16 KiB display budget are covered end to end through command normalization.
- `8de2a14` full projection and UI access. The Pi-to-canonical mapper no longer adds turn, tool, text, or tool-value clipping; producer-reported truncation remains visible in the snapshot and produces a UI warning. Every queued item is rendered in a scrollable list, and polled streaming text renders immediately without the synthetic two-character timer.
- Operational capture and clients: pending commit. Rollout capture streams archives and members to mode-0600 files while validating every unique archive path, without archive/member/listing display caps. CLI responses and canary peer messages no longer inherit content-size gates. Tests cover a 20+ MiB archive, a 64+ KiB listing with 300 members, and a CLI response beyond 64 MiB.

## Remaining platform constraints

- Queue admission remains bounded at 100 items per mode because it controls durable pending work, not transcript display.
- Canonical identifiers remain non-empty and bounded to 256 UTF-8 bytes; runtime failure codes/diagnostics and elapsed time retain their protocol bounds.
- Pi command envelopes remain bounded to 8 MiB, including JSON and image data. This is a native process transport resource bound, not a text-field admission policy.

No deployment, push, or live-session mutation is part of this work. Local and synthetic checks are not live proof.
