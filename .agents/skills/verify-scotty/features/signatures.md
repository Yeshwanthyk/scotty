# Inbound signatures

All inbound connections use one verifier in Creds. The preset is stored as configuration;
custom configurations use the same API and verifier. See `docs/design.md`, "Inbound signatures"
for the configuration shape, provider sources and timestamp units.

## Prove it

On an already deployed stage, run `npm run --silent e2e -- signatures`. It creates temporary
Linear, Slack and custom connections with no automations, sends independently signed JSON,
and removes its connections even if an assertion fails. Pass when, for all three configurations:

- A correctly signed delivery answers HTTP 200 `skipped: no_automation`, with no session.
- A changed raw body answers HTTP 401 `bad_signature` and is listed as rejected.
- A correctly signed old timestamp answers HTTP 401 `stale_timestamp` and is listed as rejected.
- Delivery IDs come from Linear's header and Slack's body field; every result is listed under
  its id with no session. Pasted secrets are absent from create responses and listings.
- Custom configuration signs a header timestamp and delivery id with the raw body, using a
  valid base64 key with a custom prefix. Omitting either signed header field is refused at
  creation with HTTP 400 and a clear message, without storing the connection.
- Invalid, empty or wrongly prefixed base64 signing keys are refused at creation with HTTP 400.

Run `e2e hooks`, `e2e automations` and `e2e github` to check the existing Standard Webhooks
start/steer/retry path, automation routing and GitHub self-event/retry behaviour. These require
sessions; the GitHub suite also needs its existing token/private-repository setup.

## Owner setup

1. In Settings → Connections choose Webhook, then Standard Webhooks, GitHub, Linear or Slack.
   Use the provider's signing secret for Linear and Slack. For CLI setup, pipe that secret into
   `scotty connect linear linear-events` or `scotty connect slack slack-events`; a pasted secret
   is never returned. Leave stdin empty to generate a secret shown once for a sender you control.
2. Read `scotty connections --json` for each hook URL and its public signing configuration.
   Paste the URL in the provider's webhook settings. The Slack preset accepts JSON event callbacks;
   the Slack bot's URL challenge/setup is separate work.
3. POST a signed delivery using the exact raw body bytes and the configured sources. Check
   `scotty deliveries --connection <name> --json` and Settings → Connections for the result.
   With no listeners, Linear/Slack skip; Standard Webhooks accepts a valid session-start payload.
4. To exercise custom configuration, create the custom example in `docs/design.md` through
   `POST /api/connections`, sign the raw body as hex HMAC-SHA256 using the full returned secret,
   and send `x-signature: sha256=<hex>` with body
   `{"delivery":{"id":"custom-1"},"event":{"type":"example"}}`. Expect `no_automation`;
   append a space without resigning and expect `bad_signature`, both listed under `custom-1`.
5. Remove only this run's connections with `scotty rm connection <name>`.

## Find what broke

- HTTP 302: check the `/hooks/*` Access bypass. HTTP 404: check the connection name.
- HTTP 400 `missing_headers`: check all configured sources, including payload `event_id`,
  `event.type` and `webhookTimestamp`. `bad_body` means invalid JSON (a header event source also requires an object);
  HTTP 413 means it exceeded 64 KiB.
- HTTP 401 `bad_signature`: sign exact bytes. Standard Webhooks decodes the base64 key after
  `whsec_`; GitHub, Linear and Slack use the complete secret string. Slack signs the timestamp
  with the body, Linear signs only the body, and neither uses Standard Webhooks' id template.
- `stale_timestamp`: Linear's payload timestamp is milliseconds with a 60 s tolerance;
  Slack and Standard Webhooks use seconds with a 300 s tolerance. Both past and future skew count.
- `no_automation`: verification succeeded, but no listener is installed. `scotty runs` shows
  automation filters or template failures only after a listener receives the delivery.
