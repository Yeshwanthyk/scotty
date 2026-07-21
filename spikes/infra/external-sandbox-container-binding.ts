import type { ContainerApplication, DurableObjectLike, Worker } from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

type SandboxHost = Pick<Worker, "LogicalId" | "bind" | "durableObjectNamespaces">;

type SandboxContainer = Pick<ContainerApplication, "LogicalId" | "bind" | "dev">;

export interface ExternalSandboxContainerBinding {
  readonly worker: SandboxHost;
  readonly container: SandboxContainer;
  readonly durableObject: Pick<DurableObjectLike, "className" | "name">;
}

/**
 * Associates an externally implemented Durable Object with an Alchemy
 * Container application using only the resources' public binding contracts.
 * Alchemy's Worker and Container providers remain the sole reconcilers.
 */
export const bindExternalSandboxContainer = Effect.fnUntraced(function* ({
  worker,
  container,
  durableObject,
}: ExternalSandboxContainerBinding) {
  const className = durableObject.className ?? durableObject.name;
  const namespaceId = worker.durableObjectNamespaces.pipe(
    Output.map((namespaces) => {
      const resolved = namespaces[className];
      if (resolved === undefined) {
        throw new Error(
          `Worker ${worker.LogicalId} did not expose Durable Object namespace ${className}.`,
        );
      }
      return resolved;
    }),
  );

  yield* container.bind(durableObject.name, {
    durableObjects: { namespaceId },
  });

  yield* worker.bind(container.LogicalId, {
    containers: [
      {
        className,
        dev: container.dev,
      },
    ],
  });
});
