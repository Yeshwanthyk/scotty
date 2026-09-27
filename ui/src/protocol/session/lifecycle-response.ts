import { Schema } from "effect";

/** A lifecycle POST returns the ordinary session view with this marker while it is in progress. */
export const LifecyclePendingMarkerSchema = Schema.Struct({ pending: Schema.Literal(true) });
