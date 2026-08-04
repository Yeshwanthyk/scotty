# Scotty browser assets

`scotty-ui.css` and `brand/` apply the committed Scotty painted identity across the session list,
device manager, and pairing flow. The UI uses the small app mark for persistent
identity and role glyphs only at meaningful empty, loading, security, and completion states.
The deployable files in `brand/` mirror or derive from selected source artwork in `assets/brand/`.

Pi runs inside the session container through one loopback-only RPC supervisor. The authenticated
worklog at `/s/:id` receives snapshots and live events through same-origin Worker routes; container
ports and browser credentials are never forwarded. Root credentials are never accepted from
cookies or query parameters.

The worklog uses only `/s/:id/console/v1/{snapshot,events,command}`. Commands are serialized with
their snapshot epoch and session revision, and unconfirmed or stale mutations are held for explicit
operator review rather than replayed.

`devices.html` is the primary-device-only browser manager. It creates five-minute one-use pairing
links, starts target-bound ownership transfers, distinguishes the server-derived `Primary` role
from `This device`, and renders capability QR matrices locally. `pair.html`, `owner-transfer.html`,
and `recover.html` remove their link fragments before any fetch and require an explicit click.
Their executable code lives in static JavaScript files so the Worker can apply the strict
authentication-page CSP without `unsafe-inline` scripts.

The pages assume these same-origin endpoints:

- `GET /api/sessions` returns either an array of session projections or `{ "sessions": [...] }` with `id` and `status` fields.
- `GET /api/stats` returns retained workspace creation counts grouped by repository identity and joined to current warm or sleeping session projections.
- `POST /api/sessions/:id/resume` starts restore/resume and returns a successful HTTP status when accepted.
