---
name: Scotty
description: A live workshop for fast, trustworthy cloud coding.
colors:
  space: "#0a0a0a"
  shell: "#111111"
  panel: "#121212"
  panel-raised: "#181818"
  control: "#101010"
  ink: "#f5f5f5"
  muted: "rgb(255 255 255 / 0.62)"
  quiet: "rgb(255 255 255 / 0.46)"
  line: "rgb(255 255 255 / 0.12)"
  accent: "#cf633f"
  accent-strong: "#e07954"
  focus: "#7ed9e8"
  danger: "#ff8278"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 650
    lineHeight: 1.3
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 650
    lineHeight: 1.25
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.control}"
    rounded: "{rounded.sm}"
    padding: "0 15px"
    height: "44px"
  button-quiet:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "0 13px"
    height: "40px"
  input:
    backgroundColor: "{colors.control}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "44px"
---

# Design System: Scotty

## 1. Overview

**Creative North Star: "The Live Workshop"**

Scotty is a shared working surface, not a dashboard of abstractions. The repository, session, conversation, lifecycle, and evidence should feel physically connected: state changes remain in place, actions stay close to their object, and navigation never interrupts the team's sense of location.

The system is calm, precise, and responsive. It uses compact, familiar controls and neighboring near-black tonal layers. It rejects generic SaaS card grids, ornamental metrics, excessive chrome, and raw infrastructure failures presented as user states.

**Key Characteristics:**

- Dense enough for active development without becoming terminal cosplay.
- Stable layouts across loading, streaming, retrying, and completion.
- One interaction vocabulary across every route and viewport.
- State color is semantic and scarce; text remains the primary explanation.
- Motion preserves continuity and never delays an action.

## 2. Colors

Near-black tonal layers form the workshop; warm rust identifies deliberate action, cool cyan identifies focus, and danger red is reserved for destructive or terminal failure states.

### Primary

- **Workshop Rust** (`#cf633f`): Primary emphasis and intentional activation, used sparingly.
- **Workshop Rust Strong** (`#e07954`): Hover or selected emphasis where contrast requires it.

### Neutral

- **Deep Space** (`#0a0a0a`): Application background.
- **Workshop Shell** (`#111111`): Persistent navigation and framing.
- **Work Surface** (`#121212`): Primary panels and conversation surface.
- **Raised Tool** (`#181818`): Interactive controls and temporary emphasis.
- **Working Ink** (`#f5f5f5`): Primary text and high-emphasis controls.
- **Muted Ink** (`rgb(255 255 255 / 0.62)`): Secondary text that must remain readable.
- **Quiet Ink** (`rgb(255 255 255 / 0.46)`): Timestamps and tertiary metadata only.
- **Structural Line** (`rgb(255 255 255 / 0.12)`): Dividers and explicit boundaries.

### Named Rules

**The Scarce Signal Rule.** Accent, focus, and danger colors communicate action or state only. They never decorate inactive surfaces.

## 3. Typography

**Display Font:** System UI sans-serif
**Body Font:** System UI sans-serif
**Label/Mono Font:** Platform monospace only for identifiers, commands, and terminal content

**Character:** A single crisp sans-serif keeps product language direct. Weight and spacing establish hierarchy; decorative font pairing does not belong in the working surface.

### Hierarchy

- **Headline** (650, 1.75rem, 1.1): Route titles and rare empty-state headings, balanced wrapping.
- **Title** (650, 0.875rem, 1.3): Session names, panel headings, and primary row labels.
- **Body** (400, 0.875rem, 1.55): Conversation and explanatory text, capped near 72ch outside data surfaces.
- **Label** (650, 0.75rem, 1.25): Controls, metadata labels, and compact navigation.

### Named Rules

**The Stable Number Rule.** Durations, counts, progress, and sequences use tabular numerals so streaming updates never shift adjacent content.

## 4. Elevation

Scotty uses tonal layering and structural dividers rather than decorative shadows. Shadows appear only when an element truly leaves the document plane, such as a popover, dialog, dragged item, or transient menu.

### Named Rules

**The Flat-by-Default Rule.** Persistent surfaces use color and borders. Only overlays earn a small, defined shadow.

## 5. Components

Controls are quiet and immediate: familiar at rest, unmistakable on hover and focus, and physically responsive without visual noise.

### Buttons

- **Shape:** 6px radius with a 40px dense or 44px touch-safe hit area.
- **Primary:** Light ink surface with dark text; reserve for the single next action.
- **Hover / Focus:** Exact color transitions in 120–180ms, cyan focus outline, and `scale(0.96)` press feedback.
- **Quiet / Danger:** Tonal or transparent at rest; labels and icons use the same semantic color.

### Chips

- **Style:** Compact tonal background with readable text and no decorative glow.
- **State:** Selection uses a stronger surface plus text/icon change, never color alone.

### Cards / Containers

- **Corner Style:** 8–12px only where grouping needs a contained surface.
- **Background:** Space, shell, panel, and raised-tool layers.
- **Shadow Strategy:** None for persistent layout.
- **Border:** Structural line only; avoid nested outlined cards.
- **Internal Padding:** 12–24px based on information density.

### Inputs / Fields

- **Style:** 44px control surface, 8px radius, structural border, and readable placeholder.
- **Focus:** Cyan outline with no layout shift.
- **Error / Disabled:** Persistent text explanation plus semantic color and disabled behavior.

### Navigation

The sidebar is a stable project-and-session index. Rows retain identity across refreshes, use native navigation through the router, and expose selected, pending, sleeping, failed, and deleting states consistently. Mobile collapses the shell structurally rather than shrinking typography.

### Lifecycle State Panel

One state panel explains the authoritative session state, freshness, active operation, valid next actions, and recovery. Expected transition conflicts remain pending states; terminal failures and gone sessions have explicit endpoints.

## 6. Do's and Don'ts

### Do:

- **Do** preserve component identity during refreshes and streaming updates.
- **Do** use 120–180ms interruptible transitions for color, opacity, scale, and transform only.
- **Do** provide static text or icon feedback alongside every motion cue.
- **Do** test default, hover, focus, active, disabled, loading, error, empty, and lifecycle variants.
- **Do** use one `currentColor` icon system with consistent 1.5px or 2px stroke weight.

### Don't:

- **Don't** turn Scotty into a generic SaaS dashboard of interchangeable cards and ornamental metrics.
- **Don't** replace or detach active navigation targets during pointer or keyboard interaction.
- **Don't** present HTTP 409, lease contention, stale projection, or provider ambiguity as unexplained fatal errors.
- **Don't** use `transition: all`, decorative entrance choreography, overlapping hit areas, or press scales below `0.95`.
- **Don't** use shadows to decorate persistent containers or combine wide soft shadows with outlined cards.
