import type * as cf from "@cloudflare/workers-types";
import type { Effect } from "effect";
import { cloudflarePlace } from "./cloudflare.js";
import { checkDaytonaKey, daytonaPlace } from "./daytona.js";
import type { KeyedPlace, Place, PlaceFailed, PlaceKind } from "./place.js";

type Op = typeof PlaceFailed.fields.op.Type;

/** Every place, built for one Session DO. */
export const makePlaces = (input: {
  readonly container: cf.Container;
  readonly exports: object;
  readonly env: Readonly<Record<string, unknown>>;
  readonly key: (kind: typeof KeyedPlace.Type, op: Op) => Effect.Effect<string, PlaceFailed>;
}) =>
  ({
    cloudflare: cloudflarePlace(input.container, input.exports),
    daytona: daytonaPlace({ key: (op) => input.key("daytona", op), env: input.env }),
  }) satisfies Record<typeof PlaceKind.Type, Place>;

/** The HTTP status each keyed place answers a read made with a candidate key. */
export const placeKeyChecks = {
  daytona: checkDaytonaKey,
} satisfies Record<typeof KeyedPlace.Type, (key: string) => Effect.Effect<number, unknown>>;
