import { Schema } from "effect";

// Lowercase and explicit: the name is in the hook URL and in every session it starts.
export const connectionName = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ConnectionName = Schema.String.check(Schema.isPattern(connectionName));

// A key ties deliveries (or API creates) to one session.
export const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const DeliveryOutcome = Schema.Literals(["accepted", "rejected", "duplicate"]);
// Why a delivery was rejected; the UI and CLI decode these same codes.
export const DeliveryReason = Schema.Literals([
  "missing_headers",
  "too_large",
  "bad_signature",
  "stale_timestamp",
  "bad_body",
  "repository_not_found",
  "repository_unavailable",
  "key_conflict",
  "session_unavailable",
]);
// How many deliveries are kept; older ones are dropped as new ones arrive.
export const keptDeliveries = 500;
