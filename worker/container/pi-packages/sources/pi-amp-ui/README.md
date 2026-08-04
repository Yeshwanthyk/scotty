# pi-amp-ui

An Amp Neo-inspired shell for the `@earendil-works/pi-coding-agent` fork of Pi.

This first pass reproduces the parts Pi extensions can safely own:

- compact `Welcome to Pi · Amp Neo shell` startup header
- rounded, minimum-three-row prompt frame
- context usage percentage, model, and thinking level on the top border
- explicit idle plus animated thinking, streaming, named running-tool, queue, and auto-compaction states
- provider-reported output token counts when Pi exposes them; no local token guesses
- cumulative processed tokens and latest cache-hit rate on the top border, including reported tool and summary usage
- context usage rail after the active state label on the bottom border
- cwd and git branch on the bottom border
- `alt+t` to expand or collapse work details, matching Amp

## Run locally

Run the extension directly:

```bash
pi -e /Users/yesh/code/personal/pi-amp-ui/index.ts
```

For normal use, install the package directory:

```bash
pi install /Users/yesh/code/personal/pi-amp-ui
```

Then start Pi normally. Use `/amp` to toggle the shell, `/amp on`, or `/amp off`.

## Theme behavior

The shell uses Pi's currently selected theme and never changes the theme setting. The editor chrome updates with theme changes live.

## Known fidelity boundary

Pi currently constructs `UserMessageComponent` and `AssistantMessageComponent` directly in interactive mode. `registerMessageRenderer()` only handles extension-authored custom messages. That means an extension can restyle transcript colors but cannot reproduce Amp's green left-rule user rows, exact spacing, or global assistant row renderer.

A pixel-accurate transcript needs a small upstream Pi hook, such as:

```ts
ctx.ui.setMessageComponentFactory({
  user: (message, context) => Component,
  assistant: (message, context) => Component,
});
```

Tool cards are technically replaceable today, but Pi's API replaces the complete tool definition—including execution—when a built-in tool name is re-registered. This package intentionally does not couple visual styling to tool execution in its first pass.
