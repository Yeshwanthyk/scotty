import type * as cf from "@cloudflare/workers-types";
import type { Effect } from "effect";
import { boatPlace, checkBoatKey } from "./boat.js";
import { cloudflarePlace } from "./cloudflare.js";
import { checkDaytonaKey, daytonaPlace } from "./daytona.js";
import type { KeyedPlace, Place, PlaceFailed, PlaceKind } from "./place.js";

type Op = typeof PlaceFailed.fields.op.Type;
interface PlaceInput {
  readonly container: cf.Container;
  readonly exports: object;
  readonly env: Readonly<Record<string, unknown>>;
  readonly key: (kind: typeof KeyedPlace.Type, op: Op) => Effect.Effect<string, PlaceFailed>;
}

const modules = {
  cloudflare: { make: (input: PlaceInput) => cloudflarePlace(input.container, input.exports) },
  daytona: {
    make: (input: PlaceInput) =>
      daytonaPlace({ key: (op) => input.key("daytona", op), env: input.env }),
    checkKey: checkDaytonaKey,
  },
  boat: {
    make: (input: PlaceInput) => boatPlace({ key: (op) => input.key("boat", op), env: input.env }),
    checkKey: checkBoatKey,
  },
} satisfies Record<
  typeof PlaceKind.Type,
  {
    readonly make: (input: PlaceInput) => Place;
    readonly checkKey?: (key: string) => Effect.Effect<number>;
  }
>;

/** The place of each kind for one Session DO, made on first use and kept. */
export const makePlaces = (input: PlaceInput) => {
  const made = new Map<typeof PlaceKind.Type, Place>();
  return (kind: typeof PlaceKind.Type) => {
    const known = made.get(kind);
    if (known !== undefined) return known;
    const place = modules[kind].make(input);
    made.set(kind, place);
    return place;
  };
};

/** The HTTP status a keyed place answers a read made with a candidate key, or 0 if unreachable. */
export const checkPlaceKey = (kind: typeof KeyedPlace.Type, key: string) =>
  modules[kind].checkKey(key);
