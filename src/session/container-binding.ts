import * as Output from "alchemy/Output";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import type { SessionContainer } from "./object.js";

/**
 * Attach the container application to the Session DO class at deploy time without starting it.
 * Mirrors ContainerPlatform.bind (vendor Containers/ContainerPlatform.ts:143-172); Containers.layer
 * would also start the container on every DO construction (docs/design.md "Supervisor").
 */
export const bindSessionContainer = (container: typeof SessionContainer) =>
  Effect.gen(function* () {
    const namespace = yield* Cloudflare.DurableObjectScope;
    const application = yield* container.Application;
    yield* application.bind`${namespace}`({
      durableObjects: { namespaceId: namespace.namespaceId },
    });
    const worker = yield* Cloudflare.Worker;
    yield* worker.bind`${application.LogicalId}`({
      containers: [
        {
          className: namespace.name,
          dev: application.dev,
          hash: application.hash.pipe(Output.map((hash) => hash?.image)),
        },
      ],
    });
  });
