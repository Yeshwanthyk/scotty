# Conversation projection

The rebuilt UI does not read Pi or Codex session files directly and does not adopt either
provider's persisted schema. A provider adapter decodes its own source and emits one UI-owned,
bounded conversation projection.

## Page contract

```text
GET /api/sessions/:id/conversation?before=<opaque cursor>&limit=20

page
  turns[]                 newest chronological window only
  earlier.remaining      count, when known
  earlier.cursor         opaque provider-owned cursor, or null
  live.generation        runtime generation fence
  live.sequence          last applied event sequence
```

The first read must not load the entire session. The UI renders the newest page and requests one
older page when the operator selects **Show earlier turns**. The adapter owns cursor decoding;
the browser never constructs a Pi or Codex file offset.

## UI turn projection

```text
turn
  id                     stable within the source session
  state                  completed | streaming | failed | aborted
  user                   sanitized display text
  activitySummary?       bounded, display-safe progress summary
  tools[]
    id                   stable call ID
    state                completed | running | failed | cancelled
    label                semantic UI label
    invocation           bounded, redacted summary
    output?              bounded, redacted display output
  assistant              accumulated display text
```

`activitySummary` is not raw chain-of-thought. Encrypted reasoning, hidden reasoning content,
signatures, credentials, environment values, and unrestricted tool arguments/results never enter
the projection.

## Provider crosswalk

| UI fact               | Pi source                                  | Codex source                                                      |
| --------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| Session metadata      | `session`                                  | `session_meta`                                                    |
| User turn             | `message(role=user)`                       | `response_item.message(role=user)` / `event_msg.user_message`     |
| Assistant text        | assistant text parts and deltas            | `response_item.message(role=assistant)` / completed agent message |
| Display-safe activity | bounded visible thinking/status            | explicit reasoning summary or progress event only                 |
| Tool call             | assistant `toolCall` plus execution events | function/custom/MCP tool-call items and events                    |
| Tool result           | `toolResult` / execution end               | function/custom/MCP output or completion event                    |
| Turn terminality      | turn end/abort events                      | task complete plus completed item boundaries                      |
| Compaction            | `compaction`                               | `compacted` / context-compacted event                             |

## Ordering and replay

- Fence live events by session ID, turn ID, runtime generation, and monotonic sequence.
- Deduplicate with the provider's stable item/call ID after decoding.
- A sequence gap or generation change triggers a bounded page refresh; it never guesses the
  missing state.
- Compaction changes retained history, not lifecycle authority.
- A tool cannot remain `running` after its turn becomes terminal. Missing provider terminal data
  projects the turn as `failed` or `aborted`, never `completed`.
