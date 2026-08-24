---
title: Define the minimum browser surface
status: closed
label: wayfinder:prototype
mode: HITL
assignee: yesh
blocked_by:
  - Define the first-use and readiness contract
  - Define the canonical Session lifecycle
  - Define the credential and login state machine
---

## Question

Which exact pages, information, and actions must remain in the alpha browser for ownership, pairing, Session observation, and Hatch, and which current browser features and code should Scotty remove?

## Inherited state contract

The Session owns Hatch and evidence records. Live Hatch processes and views are runtime-only. R2
owns immutable screenshot and video bytes. Hatch and capture remain dormant in backend Sessions
until requested. The browser may capture, add, list, and show media only through authenticated
Session reads and operations, and old runtime generations must lose access after every stop or Resume.

## Inherited credential contract

The browser may perform explicit human OAuth handoffs and show sanitized Credential-object status,
Plugin requirement blockers, operation progress, and staged failures. It never receives a real
credential, wrapping key, ciphertext, Session sentinel, provider token, or raw provider response.

## Resolution

Keep the current browser experience as the required alpha browser surface. This ticket does not
redesign it, reduce it to a new concept of “minimum,” or move an existing browser workflow to the
CLI or TUI merely because those are the primary surfaces. “Minimum” means the current coherent
browser product, with only changes required by alpha decisions that are already settled elsewhere.

The required browser surface is:

- the Sessions home, including creation, listing, opening, renaming, stopping, resuming, and
  deleting Sessions;
- the interactive Session worklog, including revision-bound Pi input, runtime controls, Summary,
  subagent and workflow observation, and recovery of held browser commands;
- authenticated Hatch opening and live Hatch access;
- retained evidence list, detail, media, and before/after Showcase views;
- browser ownership, pairing, transfer, recovery, and device revocation;
- the current environment, provider, and statistics views and their operator actions; and
- the existing canonical redirects, authentication gates, private media routes, and health route
  that support those pages.

Preserve the current information hierarchy, interaction model, and painted browser identity. Do
not introduce a replacement dashboard or a new browser navigation model as part of the alpha
specification.

Other settled alpha decisions may flow into this surface only where necessary. In particular:

- use the canonical Session states and operation views rather than Legacy lifecycle names;
- show projections as derived views and obtain mutation results from the authoritative owner;
- support the explicit compute-provider and named-runner choices already required at Session
  creation;
- show sanitized readiness, Plugin-requirement, Credential, and operation status where the
  first-use and configuration contracts require browser handoff or observation;
- support explicit human OAuth and browser-ownership handoffs; and
- never return or render a real Credential, wrapping key, ciphertext, Session sentinel, provider
  token, or raw provider response. Any current environment behavior that overlaps the canonical
  Credential system must adopt that already-decided boundary without otherwise redesigning the
  page.

This ticket removes no current user-facing browser page or workflow. Retired compatibility routes,
raw asset aliases, obsolete schemas, and implementation code superseded by the settled alpha
contracts are handled by the clean-cutover ticket; they are not reasons to shrink the browser
product here.

## Acceptance boundary

The alpha browser passes this decision when the current end-to-end browser workflows remain
recognizable and usable, their data and mutations respect the canonical owners, stopped runtime
generations cannot retain Hatch or evidence-capture access, and no real Installation credential
crosses into browser output or Session compute.

## Audit source

The decision was checked against the current route and asset inventory in `worker/src/index.ts` and
`worker/public/`. The rejected alternative-layout prototype was not adopted and is not part of the
alpha specification.

## Refined device authority

The browser owner is the one everyday pairing administrator. It may issue one-use pairing grants,
revoke standard clients, and start explicit ownership transfer. A paired terminal cannot add a
device or remove the owner. Root recovery remains outside browser state and replaces ownership only
through the separate recovery flow.


## Refined Runner surface

Runner views must separate registration, accepting/draining/disabled mode, connection, certified
release, light health, orchestrator capacity, assignments, and create-capable status. Runner Hatch
and evidence use the same browser routes and Auth policy while traffic relays over the Runner's
outbound link; the browser never connects directly to a VPS port.
