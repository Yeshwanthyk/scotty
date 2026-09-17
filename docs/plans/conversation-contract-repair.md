# Conversation contract repair

This lane removes display-era limits from the canonical conversation path while retaining identifiers, state enums, sequence ordering, queue capacity, credential sanitization, and archive path safety.

## Slice evidence

- Shared canonical decoder: pending commit. The browser now consumes the protocol decoder used to validate producer output. Coverage includes 101 turns, 53 tools, multibyte UTF-8 content, exact-key rejection, invalid states, and invalid sequence ordering.

## Remaining platform constraints

- Queue admission remains bounded at 100 items per mode because it controls durable pending work, not transcript display.
- Canonical identifiers remain non-empty and bounded to 256 UTF-8 bytes; runtime failure codes/diagnostics and elapsed time retain their protocol bounds.

No deployment, push, or live-session mutation is part of this work. Local and synthetic checks are not live proof.
