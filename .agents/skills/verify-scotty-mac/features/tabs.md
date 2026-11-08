# Tabs

Sessions open as tabs; tabs switch by click, ⌘1–9 and ⇧⌘]/[, and close with ⌘W.

## Behaviors

- **B1** Opening a second session adds a tab and shows its thread.
- **B2** ⌘1 and ⇧⌘] switch the shown thread.
- **B3** ⌘W closes the shown tab; with none left, the home page ("home") shows.

## User entry points

- Row click, ⌘K; the tab bar; the keyboard.

## Drive

```sh
ax press row:$SESSION && ax wait thread:$SESSION
ax press row:d0cc0de5000000000000000000000005 && ax wait thread:d0cc0de5000000000000000000000005  # B1
ax key cmd+1 && ax wait thread:$SESSION                    # B2
ax key cmd+w && ax key cmd+w && ax wait home               # B3
```

## Proof

A screenshot per step showing the tab bar and the thread; `ax tree | grep thread:` names the shown one.

## Gotchas

- `key` needs the app to take keys: if a keystroke does nothing, `ax front` first (macOS may refuse
  while someone uses the Mac; then press the tab instead).
