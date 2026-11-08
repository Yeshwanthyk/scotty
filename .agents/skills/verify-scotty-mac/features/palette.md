# Palette

⌘K opens a search over sessions, repositories and actions; Return opens the choice.

## Behaviors

- **P1** ⌘K or the sidebar search opens it with the field focused.
- **P2** Typing filters; Return opens the top session; Escape closes.

## User entry points

- ⌘K; the `sidebar-search` button.

## Drive

```sh
ax press sidebar-search && ax wait palette-input           # P1
ax type "status dots" && ax type $'\n' && ax wait thread:$SESSION   # P2
```

## Proof

Screenshots of the open palette with results and of the opened thread.

## Gotchas

- Escape and ⌘K go through `key`, which needs the app to take keys (see tabs.md).
