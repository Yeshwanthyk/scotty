# pi-amp-ui

An Amp Neo-inspired shell for the `@earendil-works/pi-coding-agent` fork of Pi.

This first pass reproduces the parts Pi extensions can safely own:

- Amp's ANSI-first blue/cyan/green/yellow palette
- compact `Welcome to Pi · Amp Neo shell` startup header
- rounded, minimum-three-row prompt frame
- context usage percentage, model, and thinking level on the top border
- explicit idle plus animated thinking, streaming, named running-tool, queue, and auto-compaction states
- provider-reported output token counts when Pi exposes them; no local token guesses
- context usage rail after the active state label on the bottom border
- cwd and git branch on the bottom border
- `alt+t` to expand or collapse work details, matching Amp
- transparent transcript and tool backgrounds through the bundled theme

## Run locally

Pi only discovers bundled themes when loading the directory as a package. For a direct extension test, pass the theme explicitly:

```bash
pi -e /Users/yesh/code/personal/pi-amp-ui/index.ts \
  --theme /Users/yesh/code/personal/pi-amp-ui/themes/amp-neo.json
```

For normal use, install the package directory:

```bash
pi install /Users/yesh/code/personal/pi-amp-ui
```

Then start Pi normally. Use `/amp` to toggle the shell, `/amp on`, or `/amp off`.

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
