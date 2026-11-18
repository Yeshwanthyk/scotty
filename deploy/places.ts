import * as Effect from "effect/Effect";
import { daytonaDeploy } from "./daytona.ts";

/**
 * What deploy and teardown do at a place outside Cloudflare, run only when the deploying shell
 * holds the place's API key in `env`. `prepare` answers the Worker's text bindings.
 */
export interface PlaceDeploy {
  readonly name: string;
  readonly env: string;
  readonly prepare: (
    key: string,
    stage: string,
    image: string,
  ) => Effect.Effect<Readonly<Record<string, string>>, { readonly message: string }>;
  readonly remove: (
    key: string,
    stage: string,
  ) => Effect.Effect<void, { readonly message: string }>;
  readonly leftovers: (
    key: string,
    stage: string,
  ) => Effect.Effect<readonly string[], { readonly message: string }>;
}

const placeDeploys: readonly PlaceDeploy[] = [daytonaDeploy];

/** The place steps whose key the deploying shell holds, each with that key. */
export const keyedDeploys = () =>
  placeDeploys.flatMap((place) => {
    const key = process.env[place.env]?.trim() ?? "";
    return key === "" ? [] : [{ ...place, key }];
  });
