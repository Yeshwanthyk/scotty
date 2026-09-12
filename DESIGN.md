---
name: Scotty
description: A cloud-agent workspace grounded in Cursor Cloud Agents interaction patterns.
colors:
  space: "#0a0a0a"
  shell: "#111111"
  panel: "#121212"
  panelRaised: "#181818"
  control: "#101010"
  ink: "#f5f5f5"
  muted: "rgb(255 255 255 / 0.62)"
  quiet: "rgb(255 255 255 / 0.46)"
  line: "rgb(255 255 255 / 0.12)"
  lineSoft: "rgb(255 255 255 / 0.08)"
  lineHover: "rgb(255 255 255 / 0.16)"
  beam: "#f5f5f5"
  accent: "#cf633f"
  accentStrong: "#e07954"
  focus: "#7ed9e8"
  danger: "oklch(70% 0.16 25)"
  success: "#82b394"
  warning: "#dab77e"
typography:
  sessionHeading:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "15px mobile / 16px desktop"
    fontWeight: 550
    lineHeight: 1.4
    letterSpacing: "-0.015em"
  panelHeading:
    fontSize: "15px"
    fontWeight: 680
  body:
    fontSize: "14px"
    lineHeight: 1.55
  button:
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1
  rowTitle:
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.25
  fieldLabel:
    fontSize: "12px"
    fontWeight: 650
  metadata:
    fontSize: "11px"
rounded:
  small: "6px"
  row: "7px"
  control: "8px"
  dialog: "12px"
  composer: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-default:
    backgroundColor: "{colors.control}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-primary:
    backgroundColor: "{colors.beam}"
    textColor: "oklch(18% 0.024 220)"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  input:
    backgroundColor: "{colors.control}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  session-switcher:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.dialog}"
    width: "min(560px, calc(100vw - 32px))"
---

# Scotty — Design Language Reference

## Overview

Scotty takes Cursor Cloud Agents as its primary interface reference: a compact task index, a working conversation with a persistent follow-up composer, and adjacent tools for inspecting the work. The interface should feel quiet and stable while agents run. Users should be able to find a session, understand its progress, inspect its output, and continue the conversation within one workspace.

Preserve Scotty's identity from [PRODUCT.md](PRODUCT.md) while adopting Cursor's workspace hierarchy: restrained surfaces, compact navigation, quiet progress, and readily inspectable results. The earlier [Vercel reference](https://github.com/educlopez/design-bites/blob/main/design-mds/vercel.com/DESIGN.md) informed document structure only; Cursor Cloud Agents now supplies the product and interaction reference.

### Cursor reference and evidence

Research checked on 2026-09-12. The official public demo was inspected visually and through its accessibility tree. It is a promotional representation, not an authenticated production session. The documentation establishes workflows and capabilities, not exact CSS values.

| Primary source                                                            | Evidence                                                                                                                                          | Scotty application                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [Cloud Agents public demo](https://cursor.com/cloud)                      | Compact task rail, conversation with bottom follow-up composer, adjacent Git/Desktop/Terminal/Files controls; subdued dividers and progress text. | Use a task–conversation–tools hierarchy with quiet chrome and progressive disclosure.                                            |
| [Cloud Agents overview](https://cursor.com/docs/cloud-agent)              | Web access and repository/environment context associated with each run.                                                                           | Keep repository and branch context discoverable in the session header.                                                           |
| [Capabilities](https://cursor.com/docs/cloud-agent/capabilities)          | Screenshots, videos, and log references demonstrate results; agents can use a desktop/browser.                                                    | Make existing Scotty evidence inspectable alongside conversation and code. Do not imply unsupported remote-control capabilities. |
| [Cloud environment setup](https://prod.cursor.com/docs/cloud-agent/setup) | Separate environment configuration with progress visible in a shared terminal.                                                                    | Keep setup in an explicit workflow; show meaningful progress and retain access to diagnostic detail.                             |

**Observed visual direction:** the public demo uses closely related dark surfaces, thin vertical pane boundaries, small labels and icons, a tonal selected task row, a contained prompt, open assistant prose, and a bottom composer. These observations guide hierarchy and emphasis. They are not measurements of Cursor's production palette, font, spacing, breakpoint, or focus behavior.

**Scotty adaptations:** retain repository grouping and archived sessions, authoritative sleep/resume state, hard-cap time, and existing Summary/Diff/Terminal tools. Cursor's demo groups tasks by time; that does not replace Scotty's navigation semantics. Add no new tools, PR actions, or desktop control merely because the reference displays them.

**Reference boundary:** use the agent workspace inside the demo. Its surrounding marketing typography, presentation backdrop, and large framing shadow are not application design rules. Exact values below remain Scotty's implementation baseline until deliberately revised.

### Authority and scope

This document defines the visual contract for Scotty's web UI. It combines Cursor research with the local UI source and supplied Scotty session screenshots, checked on 2026-09-12. It is not evidence that every deployed component already conforms.

- The frontmatter records shared colors and spacing from [tokens.stylex.ts](ui/src/theme/tokens.stylex.ts), plus observed typography and component geometry. Color names intentionally match the code, including the separate `ink` and `beam` roles. Preserve the source color formats.
- Component rules below define intended behavior. Items explicitly marked **Gap** are observed inconsistencies or requirements still to implement; do not copy those defects into new components.
- Reuse the owning component and shared tokens. When an approved design change alters a shared value, update its implementation and this document together. Do not introduce a competing palette or per-route button recipe.
- The shared workspace rules implement this design as the default UI. This document does not certify accessibility or change lifecycle behavior.

### Layout and density

| Region            | Existing geometry                                                 | Contract                                                                                                                      |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Desktop shell     | 240px sidebar; flexible main area                                 | Keep the session index stable and let the workspace absorb width changes.                                                     |
| Mobile shell      | At 760px and below: 52px top bar; drawer width `min(88vw, 320px)` | Collapse navigation structurally; retain accessible controls and a dismissible backdrop.                                      |
| Session workspace | Desktop horizontal padding `24px`; mobile `12px`                  | Header above a bounded, independently scrollable conversation/workbench.                                                      |
| Conversation      | Content width capped at 840px                                     | Keep reading comfortable while allowing code and tool output their own overflow.                                              |
| Workbench         | Summary overlays at 940px or less of available workbench width    | Tools adapt to available space without squeezing the conversation into an unusable column.                                    |
| Spacing           | Shared 4–32px scale in frontmatter                                | Small gaps within controls; larger gaps between semantic groups. Component-specific values need a concrete geometric purpose. |

**Stable geometry.** State, pending labels, long repository names, and streaming content must not unexpectedly change control height or move the next action. Truncate secondary identifiers or restructure the header before compressing its controls.

## Colors

### Surfaces and text

| Token                           | Role                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `space`                         | Main canvas and conversation background.                                                                   |
| `shell`                         | Persistent sidebar and mobile navigation bar.                                                              |
| `panel`                         | Contained surfaces and dialogs.                                                                            |
| `panelRaised`                   | Hovered/selected surfaces and raised controls.                                                             |
| `control`                       | Inputs and default buttons.                                                                                |
| `ink`                           | Main text and titles.                                                                                      |
| `muted`                         | Secondary labels and navigation.                                                                           |
| `quiet`                         | Timestamps, shortcuts, and supporting metadata. Never the only explanation of an error or required action. |
| `line`, `lineSoft`, `lineHover` | Structural boundaries, subtle internal boundaries, and stronger hover borders.                             |

### Actions and state

| Token                    | Role                                                                            |
| ------------------------ | ------------------------------------------------------------------------------- |
| `beam`                   | Light primary-action fill. This is the existing primary button treatment.       |
| `accent`, `accentStrong` | Restrained rust identity accents; do not replace all primary actions with rust. |
| `focus`                  | Keyboard focus and existing primary-button hover feedback.                      |
| `success`                | Positive/ready state when supported by the session presentation.                |
| `warning`                | Waiting or sleeping cues where appropriate to the state.                        |
| `danger`                 | Destructive actions and failure messages.                                       |

**Semantic color.** Pair state color with a label or recognizable icon. A bright fill belongs to the next action, not every available action. Use the session presentation's meaning; color does not invent another lifecycle state model.

Alpha colors depend on their background. Check their rendered contrast on each actual surface, including disabled and focus states. The palette alone does not prove contrast compliance.

## Typography

Use the system sans-serif stack in [global.css](ui/src/global.css). Use platform monospace for branches, commands, code, and terminal content. Scotty does not currently use Geist; the reference is not a font migration request.

| Role            | Source                                | Application                                                                             |
| --------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| Session heading | Session route; `sessionHeading` above | Session title, compact enough to share the header with controls.                        |
| Panel heading   | `SessionWorkbench`; `panelHeading`    | Tool-panel titles.                                                                      |
| Reading text    | `Conversation`; `body`                | User messages and normal conversation prose.                                            |
| Control text    | `Button`; `button`                    | Shared action labels. Preserve size, weight, and line height across lifecycle variants. |
| Session row     | `SessionRow`; `rowTitle`              | Sidebar session names; metadata sits below rather than competing with the title.        |
| Form label      | `CreateSessionForm`; `fieldLabel`     | Persistent labels above fields.                                                         |
| Metadata        | Session route; `metadata`             | State, selection, branch, and duration.                                                 |

The create-session page currently uses a larger fluid heading (`clamp(28px, 5vw, 44px)`). That is an entry-page treatment, not a heading scale for the working session. Several existing hints and tool details use 10px text; treat those as density to review, not a general-purpose size for new controls.

**Readable controls.** Labels remain legible at narrow widths and zoom. Use tabular numerals for changing durations and counts. Keep action labels on one line; allow prose to wrap. Long code and paths must not expand the outer workspace.

Control text uses the shared Button's 13px/500 baseline. Contextual lifecycle and composer controls use 12px/500 in the workspace stylesheet. Check computed styles in the rendered build when changing their typography; the global `font: inherit` reset and component rules both affect the result.

## Elevation

Use tonal surfaces and one-pixel structural borders for persistent regions. Keep the main conversation open rather than nesting it in cards.

| Surface                    | Existing shadow                 | Use                                |
| -------------------------- | ------------------------------- | ---------------------------------- |
| Small session/sidebar menu | `0 4px 8px rgb(0 0 0 / 35%)`    | Local action popover.              |
| Workbench menu             | `0 8px 24px rgb(0 0 0 / 35%)`   | Tool selection overlay.            |
| Session switcher           | `0 24px 72px rgb(0 0 0 / 55%)`  | Modal above the workspace.         |
| Mobile drawer              | `22px 0 60px rgb(0 0 0 / 0.45)` | Navigation above the main content. |

The terminal drawer casts a shadow when open. The composer uses a border without a shadow. Review layered surfaces in context before extending their treatments.

Use small corners for menu items, row corners for navigation, control corners for buttons/fields, and larger corners for dialogs/composer, as recorded in the frontmatter. The message bubble has its own asymmetric `14px 14px 4px 14px` shape; do not propagate that shape into controls.

## Components

### Shared component contract

The approved hierarchy is the default UI. Shared responsive workspace rules live in `ui/src/workspace.css`; `SessionMenu` and `SessionSelection` own menu disclosure and composer configuration. There is no comparison switch or query-parameter design mode.

- Header: session title, quiet repository text, and one ellipsis menu.
- Session menu: working/base branches, remaining time, status, and the existing lifecycle actions, including destructive confirmation.
- Composer: provider, model, and thinking remain visible inside the input surface, beside its actions. The draft area is compact at rest and expands on focus, retaining draft text on blur. Keyboard hints are hidden; delivery errors and queue controls remain available. Transition screens without a composer retain a quiet configuration label.
- Conversation: progress stays with the work; preserve message shapes and tool disclosures while refining spacing and focus behavior.
- Sidebar: title first, repository and state second, with tonal selection and compact rows.
- Mobile first: 44px action targets, 16px coarse-pointer input text, provider/model segments that wrap as units, and a drawer instead of a persistent sidebar. Desktop adds space; it does not shrink the mobile design.
- Tools: quiet controls without an extra Conversation heading. Summary overlays below 940px of available workbench width; above that it can share a split layout. Mobile tool menus close after selection.
- History: two-line summaries at narrow workspace widths, single-line truncation with separate counts when wide, quiet metadata, hover/expanded feedback, and no repeated table-like dividers.
- Menus: a single flat lifecycle action list; Escape closes the session menu and restores trigger focus. Summary supports Escape.
- Fixture honesty: the local Summary uses the existing conversation fixture and labels disconnected services; Diff states that no worktree is connected; Terminal is disabled for fixture sessions. These states do not claim deployed service health.

The composer uses a native textarea with a 32px resting draft area, 72px focused minimum on mobile, and 96px on desktop, with viewport-bounded growth and scrolling. Blur preserves the draft. This follows the requested cross-device interaction, not exact T3 parity: [T3 Code's mobile implementation](https://github.com/pingdotgg/t3code/pull/1263) collapses below 640px and preserves multiline drafts expanded. The UI retains reduced-motion handling through the global stylesheet.

### Reference-to-component mapping

| Cursor pattern                   | Scotty owner                    | Required interpretation                                                                 |
| -------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| Compact task index               | Sidebar / SessionRow            | Scan title and state quickly; preserve Scotty repository/archive grouping.              |
| Conversation with quiet progress | Conversation / LiveConversation | Keep progress subordinate to messages; disclose detailed tool output on demand.         |
| Persistent follow-up composer    | LiveConversation / Button       | Keep continuation close to the work with compact controls and clear pending behavior.   |
| Adjacent inspection tools        | SessionWorkbench                | Inspect supported evidence, diffs, and terminal output without losing session context.  |
| Small contextual controls        | Button / session route          | Lifecycle controls fit the header's density; use one consistent geometry across labels. |

### Shared buttons

Owner: [Button.tsx](ui/src/components/Button.tsx).

| Property    | Contract                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geometry    | 40px desktop minimum height, 44px at the mobile breakpoint; 8px vertical and 12px horizontal padding; 8px icon gap; control radius. Minimum height allows text zoom. |
| Variants    | `default`: control fill and line border. `primary`: beam fill and dark text. `quiet`: transparent fill/border and muted text.                                        |
| Width       | Content-sized by default. `fullWidth` only for an intentionally full-width action. Icon-only controls keep a square hit area appropriate to the viewport.            |
| Label       | One line for short actions; icon and label must not shrink into a two-line button. Reserve enough width for pending labels when practical.                           |
| Hover/press | Default uses raised surface/hover border; primary uses focus color. Press scales to 0.96 without changing layout.                                                    |
| Disabled    | Native disabled behavior, 0.48 opacity, no press transform. Pending state explains the operation rather than appearing as an unexplained disabled control.           |
| Focus       | Visible cyan 2px outline with 2px offset for keyboard interaction.                                                                                                   |

Short button labels stay on one line; lifecycle actions share a flat menu with consistent sizing. Mobile action targets are at least 44px.

### Session header and lifecycle actions

Owner: [session route](ui/src/routes/s.$sessionId.tsx).

Show the title and quiet repository text, with one session menu on the right at every width. The menu contains branches, time, status, configured agent/model/thinking, and lifecycle actions. The configured selection also appears in the composer when one is available.

Preserve the primary button's hit area while secondary metadata wraps or truncates. Sleeping, ready, pending, failed, and gone presentations should retain recognizable structure. Recovery and destructive confirmation need adjacent explanatory text. Never substitute a visually optimistic success state for an uncertain operation result.

### Sidebar and session navigation

Owners: [Sidebar](ui/src/components/Sidebar.tsx), [SessionRow](ui/src/components/SessionRow.tsx), [AppShell](ui/src/components/AppShell.tsx).

Use repository grouping, a stronger session title, quieter metadata, and a compact state icon. Selected rows combine surface/border emphasis with readable text. Hover must remain distinguishable from selection. Keep active and archived groupings explicit. Long names truncate within the row rather than pushing the sidebar wider.

Preserve row identity and keyboard focus during refreshes. The mobile drawer must expose the same destinations and a clear close action.

### Conversation and composer

Owners: [Conversation](ui/src/components/Conversation.tsx), [LiveConversation](ui/src/components/LiveConversation.tsx), [Markdown](ui/src/components/Markdown.tsx).

Following the Cursor demo's conversation hierarchy, assistant prose sits on the canvas. User messages receive a contained tonal bubble. Tool calls use compact disclosure rows and indented details rather than full-size message cards. Long commands, code, tables, and URLs must remain inspectable without forcing page-wide horizontal scrolling.

Codex Hatch and browser evidence calls use those existing tool disclosures: a stable Hatch or Browser evidence label and running, completed, or failed state. Their bounded result includes the exact `scotty-hatch:` or `scotty-evidence:` reference for the existing session evidence surfaces. Never place authenticated summary URLs, service configuration, process logs, or credentials in the conversation tool result. Repeated native call receipts update the same disclosure and must not create duplicate controls.

The composer is a distinct control surface with composer-radius corners and a shared Send button. Focus deliberately expands the editing area; this supersedes the earlier fixed-height experiment. Preserve a visible focus-within state, multiline input and space for queued-message feedback. An empty/sleeping conversation explains whether content is retained and which action continues it. Keep that message subordinate to the session title and next action.

### Workbench tabs and panels

Owner: [SessionWorkbench](ui/src/components/SessionWorkbench.tsx).

Following Cursor's adjacent tool-pane pattern, Summary, Diff, and Terminal are tools attached to the current session. Use compact text/icon controls, a visible selected state, and a consistent close action. At narrow widths use the existing compact selection/menu behavior. File lists, code panes, and terminal scrolling stay within their panels; terminal typography remains monospace.

### Forms and settings

Owners: [CreateSessionForm](ui/src/components/CreateSessionForm.tsx), [SettingsShell](ui/src/components/SettingsShell.tsx), [AdminPage](ui/src/components/AdminPage.tsx), [ResourcesSection](ui/src/components/ResourcesSection.tsx).

Use persistent labels, control surfaces, structural borders, and errors adjacent to the relevant field. The existing create-session control uses a 44px minimum height, control radius, and 14px text. Focus changes the border and adds a 2px cyan ring. Textareas expand vertically. Keep helper text separate from placeholders and preserve entered values when validation fails.

Use the shared Button for actions; group settings by user task. These files still own local field and navigation styles—there is no shared Input or Card component established by this document. Extract a primitive only when a component migration demonstrates a repeated need.

### Menus and session switcher

Owner: [SessionSwitcher](ui/src/components/SessionSwitcher.tsx), with local menus in Sidebar and the session route.

The switcher is a bounded modal with a search field, compact results, selected-result feedback, and an explicit empty state. Menus use small padded rows on a panel surface. Preserve accessible names for icon-only triggers, keyboard navigation, Escape dismissal, and focus return. Verify these behaviors rather than inferring them from appearance.

### Motion, icons, and component states

Use the shared motion values: fast 120ms, standard 180ms, easing `cubic-bezier(0.22, 1, 0.36, 1)`. Animate properties explicitly. Feedback must remain interruptible; reduced-motion preferences disable nonessential animation through the existing global rule.

Use the existing Lucide icon vocabulary and `currentColor`. Typical inline icons are 13–15px with 1.8 stroke weight; larger navigation controls may use 18px. Treat icon size separately from its clickable area. Decorative icons are hidden from assistive technology; icon-only controls have accessible labels.

For each component, verify applicable default, hover, keyboard focus, pressed, selected, disabled, pending, error, empty, and overflow states. Do not add fake states to components that have no such behavior.

### Component alignment pass

This document is the starting contract, not a completed component audit. Evaluate each owner against the Cursor reference-to-component mapping first, then against Scotty's exact geometry and lifecycle requirements. Work through the owners above in small slices. For each slice:

1. Map each visual decision to a shared token or a documented component-specific rule.
2. Check computed styles in the rendered UI, not just declarations. Resolve reset/cascade conflicts before changing the design values.
3. Exercise realistic labels and data at desktop, near the 760px breakpoint, and mobile; include 200% zoom and keyboard interaction.
4. Capture the result and record remaining gaps. Run the smallest relevant checks; changes to styling require visual proof as well as any applicable repository checks.

Continue checking lifecycle button wrapping, computed control typography, and compact mobile hit areas. The shared icon-only button is 44px wide at the mobile breakpoint; check settings and workbench controls against the same touch-control target without reducing content readability.

## Do's and Don'ts

### Do

- Root hierarchy and interaction in the Cursor reference-to-component mapping; root exact values in Scotty tokens and component rules.
- Preserve compact controls, stable session navigation, and an open reading surface.
- Let metadata yield space before primary actions do.
- Pair lifecycle labels with semantic visual feedback and retain explicit recovery context.
- Verify rendered geometry, focus, text contrast, zoom, and overflow using realistic session content.

### Don't

- Turn Scotty into a generic SaaS dashboard with interchangeable card grids, ornamental metrics, or decorative status color.
- Copy marketing-page styling into the agent workspace, or present unmeasured values as Cursor production tokens.
- Treat every current one-off value or screenshot defect as an approved design token.
- Fix a wrapped action by clipping it into a fixed-height box or shrinking its text.
- Introduce a parallel component style system, generic card shadow, or undocumented per-route primary button.
- Claim that documenting a rule proves the deployed UI follows it.
