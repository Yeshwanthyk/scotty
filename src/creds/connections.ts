import { Schema } from "effect";

// Lowercase and explicit: the name is in the hook URL and in every session it starts.
export const connectionName = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ConnectionName = Schema.String.check(Schema.isPattern(connectionName));

// A key ties deliveries (or API creates) to one session.
export const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const DeliveryOutcome = Schema.Literals(["accepted", "rejected", "duplicate"]);
// How many deliveries are kept; older ones are dropped as new ones arrive.
export const keptDeliveries = 500;

// A delivery claimed and not settled for this long can be taken over by a retry.
export const claimTakeoverMs = 60_000;
