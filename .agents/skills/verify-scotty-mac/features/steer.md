# Steer

Opening a session shows its thread; a typed message steers it into a new turn that streams in.

## Behaviors

- **T1** Clicking a row opens the session's thread in a tab.
- **T2** Typing in the composer enables Send.
- **T3** Send adds the message to the thread, clears the composer and shows "Queued".
- **T4** The turn streams in: the header and row show Working, then the agent's items.

## User entry points

- Sidebar row click; ⌘K then Return on a session.
- Send button; Return in the composer.

## Drive

```sh
ax press row:$SESSION && ax wait thread:$SESSION 15      # T1
ax press composer:$SESSION
ax type "verify: add a legend under the dots"            # T2: send is no longer dimmed
ax press send                                            # T3
sleep 6                                                  # T4: the seed plays a scripted turn
```

Take a screenshot after each step, with `record.sh` running across all of them.

## Proof

- Screenshots: the list, the opened thread, the typed composer, and the turn with the message,
  Working and "Queued".
- Side effect: `curl -s "$SEED_URL/api/sessions/$SESSION/log" | jq '[.[]|select(.kind=="prompt.requested")]|last'`
  has `src: "api"` and the typed text.

## Gotchas

- The seed plays a canned turn whatever the text says; check the message and the event, not the reply's words.
- `ax press composer:<id>` focuses it; `type` goes to the focused field only.
