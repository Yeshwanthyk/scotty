import type { DevContainerImage } from "alchemy/Cloudflare";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource, type Resource as AlchemyResource, type ResourceBinding } from "alchemy/Resource";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { readFileSync } from "node:fs";
import { assert, expect, it } from "vitest";
import { bindExternalSandboxContainer } from "./external-sandbox-container-binding.ts";

interface ProofWorker extends AlchemyResource<
  "Scotty.ProofWorker",
  { namespaceId: string },
  {
    workerName: string;
    durableObjectNamespaces: Record<string, string>;
    containerClasses: string[];
  },
  {
    containers?: {
      className: string;
      dev: DevContainerImage | undefined;
    }[];
  }
> {}

const ProofWorker = Resource<ProofWorker>("Scotty.ProofWorker");

interface ProofContainer extends AlchemyResource<
  "Scotty.ProofContainer",
  Record<string, never>,
  {
    applicationId: string;
    durableObjects: { namespaceId: string } | undefined;
    dev: DevContainerImage | undefined;
  },
  { durableObjects?: { namespaceId: string } }
> {}

const ProofContainer = Resource<ProofContainer>("Scotty.ProofContainer");

interface ProofCloud {
  readonly workers: Map<string, ProofWorker["Attributes"]>;
  readonly containers: Map<string, ProofContainer["Attributes"]>;
  readonly calls: string[];
  interruptContainer: "after-create" | "after-delete" | undefined;
  nextApplicationId: number;
}

const cloud: ProofCloud = {
  workers: new Map(),
  containers: new Map(),
  calls: [],
  interruptContainer: undefined,
  nextApplicationId: 1,
};

const copy = <A>(value: A): A => structuredClone(value);

const onlyContainerClassNames = (
  bindings: ReadonlyArray<ResourceBinding<ProofWorker["Binding"]>>,
): string[] =>
  bindings.flatMap((binding) => binding.data.containers?.map(({ className }) => className) ?? []);

const onlyNamespace = (
  bindings: ReadonlyArray<ResourceBinding<ProofContainer["Binding"]>>,
): { namespaceId: string } | undefined => {
  const namespaces = bindings.flatMap((binding) =>
    binding.data.durableObjects === undefined ? [] : [binding.data.durableObjects],
  );
  return namespaces[0];
};

const proofWorkerProvider = Provider.succeed(ProofWorker, {
  list: () => Effect.succeed([...cloud.workers.values()].map(copy)),
  read: ({ id }) =>
    Effect.sync(() => {
      cloud.calls.push(`worker:read:${id}`);
      const value = cloud.workers.get(id);
      return value === undefined ? undefined : copy(value);
    }),
  precreate: ({ id, news }) =>
    Effect.succeed({
      workerName: id,
      durableObjectNamespaces: { ScottySandbox: news.namespaceId },
      containerClasses: [],
    }),
  reconcile: ({ id, news, bindings }) =>
    Effect.sync(() => {
      cloud.calls.push(`worker:reconcile:${id}`);
      const attributes = {
        workerName: id,
        durableObjectNamespaces: { ScottySandbox: news.namespaceId },
        containerClasses: onlyContainerClassNames(bindings),
      };
      cloud.workers.set(id, copy(attributes));
      return attributes;
    }),
  delete: ({ id }) =>
    Effect.sync(() => {
      cloud.calls.push(`worker:delete:${id}`);
      cloud.workers.delete(id);
    }),
});

const proofContainerProvider = Provider.succeed(ProofContainer, {
  list: () => Effect.succeed([...cloud.containers.values()].map(copy)),
  read: ({ id }) =>
    Effect.sync(() => {
      cloud.calls.push(`container:read:${id}`);
      const value = cloud.containers.get(id);
      return value === undefined ? undefined : copy(value);
    }),
  diff: ({ oldBindings, newBindings }) =>
    Effect.sync(() => {
      if (!isResolved(newBindings)) return undefined;
      const oldNamespace = onlyNamespace(oldBindings);
      const newNamespace = onlyNamespace(newBindings);
      if ((oldNamespace === undefined) !== (newNamespace === undefined)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
  precreate: ({ id }) =>
    Effect.succeed({
      applicationId: `precreated:${id}`,
      durableObjects: undefined,
      dev: undefined,
    }),
  reconcile: Effect.fn(function* ({ id, bindings, output }) {
    cloud.calls.push(`container:reconcile:${id}`);
    const durableObjects = onlyNamespace(bindings);
    const observed = cloud.containers.get(id) ?? output;
    const replacingAssociation =
      observed?.durableObjects?.namespaceId !== durableObjects?.namespaceId;
    if (replacingAssociation && observed !== undefined) {
      cloud.containers.delete(id);
      cloud.calls.push(`container:delete-association:${id}`);
      if (cloud.interruptContainer === "after-delete") {
        cloud.interruptContainer = undefined;
        return yield* Effect.interrupt;
      }
    }
    const attributes = {
      applicationId: replacingAssociation
        ? `application:${cloud.nextApplicationId++}`
        : (observed?.applicationId ?? `application:${cloud.nextApplicationId++}`),
      durableObjects,
      dev: undefined,
    };
    cloud.containers.set(id, copy(attributes));
    if (replacingAssociation) {
      cloud.calls.push(`container:replace-association:${id}`);
    }
    if (cloud.interruptContainer === "after-create") {
      cloud.interruptContainer = undefined;
      return yield* Effect.interrupt;
    }
    return attributes;
  }),
  delete: ({ id }) =>
    Effect.sync(() => {
      cloud.calls.push(`container:delete:${id}`);
      cloud.containers.delete(id);
    }),
});

const providers = Layer.mergeAll(proofWorkerProvider, proofContainerProvider);
const { test } = Test.make({ providers });

const program = (namespaceId: string, bind = true) =>
  Effect.gen(function* () {
    const worker = yield* ProofWorker("SandboxHost", { namespaceId });
    const container = yield* ProofContainer("SandboxContainer", {});
    const durableObject = {
      name: "Sandbox",
      className: "ScottySandbox",
    };

    if (bind) {
      yield* bindExternalSandboxContainer({
        worker,
        container,
        durableObject,
      });
    }

    return { worker, container };
  });

test.provider("public binding topology converges through the synthetic provider seam", (stack) =>
  Effect.gen(function* () {
    cloud.workers.clear();
    cloud.containers.clear();
    cloud.calls.length = 0;
    cloud.interruptContainer = undefined;
    cloud.nextApplicationId = 1;

    const createPlan = yield* stack.plan(program("namespace-a"));
    expect(createPlan.resources.SandboxHost).toMatchObject({
      action: "create",
      bindings: [
        {
          action: "create",
          sid: "SandboxContainer",
          data: {
            containers: [{ className: "ScottySandbox" }],
          },
        },
      ],
    });
    expect(createPlan.resources.SandboxContainer).toMatchObject({
      action: "create",
      bindings: [
        {
          action: "create",
          sid: "Sandbox",
          data: {
            durableObjects: {
              namespaceId: expect.anything(),
            },
          },
        },
      ],
    });

    const deployed = yield* stack.deploy(program("namespace-a"));
    expect(deployed.worker.containerClasses).toEqual(["ScottySandbox"]);
    expect(deployed.container.durableObjects).toEqual({
      namespaceId: "namespace-a",
    });
    const containerProvider = yield* ProofContainer.Provider;
    assert(containerProvider.read !== undefined);
    expect(
      yield* containerProvider.read({
        id: "SandboxContainer",
        fqn: "SandboxContainer",
        instanceId: "synthetic-instance",
        olds: {},
        output: deployed.container,
      }),
    ).toEqual(deployed.container);

    cloud.calls.length = 0;
    const repeatPlan = yield* stack.plan(program("namespace-a"));
    expect(repeatPlan.resources.SandboxHost?.action).toBe("noop");
    expect(repeatPlan.resources.SandboxContainer?.action).toBe("update");

    const replacementsBeforeRepeat = cloud.calls.filter((call) =>
      call.startsWith("container:replace-association:"),
    ).length;
    const repeated = yield* stack.deploy(program("namespace-a"));
    expect(repeated.container.durableObjects).toEqual({
      namespaceId: "namespace-a",
    });
    expect(
      cloud.calls.filter((call) => call.startsWith("container:replace-association:")),
    ).toHaveLength(replacementsBeforeRepeat);

    cloud.calls.length = 0;
    const normalizedPlan = yield* stack.plan(program("namespace-a"));
    expect(normalizedPlan.resources.SandboxHost?.action).toBe("noop");
    expect(normalizedPlan.resources.SandboxContainer?.action).toBe("noop");
    expect(cloud.calls).toEqual([]);

    const removalPlan = yield* stack.plan(program("namespace-a", false));
    expect(removalPlan.resources.SandboxContainer?.action).toBe("replace");

    const replacementPlan = yield* stack.plan(program("namespace-b"));
    expect(replacementPlan.resources.SandboxContainer?.action).toBe("update");
    const replaced = yield* stack.deploy(program("namespace-b"));
    expect(replaced.container.durableObjects).toEqual({
      namespaceId: "namespace-b",
    });
    expect(cloud.calls).toContain("container:replace-association:SandboxContainer");

    cloud.interruptContainer = "after-delete";
    const interruptedAfterDelete = yield* Effect.exit(stack.deploy(program("namespace-c")));
    assert(Exit.isFailure(interruptedAfterDelete));
    expect(cloud.containers.has("SandboxContainer")).toBe(false);

    const recoveredAfterDelete = yield* stack.deploy(program("namespace-c"));
    expect(recoveredAfterDelete.container.durableObjects).toEqual({
      namespaceId: "namespace-c",
    });

    cloud.interruptContainer = "after-create";
    const interruptedAfterCreate = yield* Effect.exit(stack.deploy(program("namespace-d")));
    assert(Exit.isFailure(interruptedAfterCreate));
    expect(cloud.containers.get("SandboxContainer")?.durableObjects).toEqual({
      namespaceId: "namespace-d",
    });
    const applicationAfterInterruptedCreate =
      cloud.containers.get("SandboxContainer")?.applicationId;

    const converged = yield* stack.deploy(program("namespace-d"));
    expect(converged.container.durableObjects).toEqual({
      namespaceId: "namespace-d",
    });
    expect(converged.container.applicationId).toBe(applicationAfterInterruptedCreate);

    yield* stack.destroy();
    expect(cloud.workers.size).toBe(0);
    expect(cloud.containers.size).toBe(0);
  }),
);

it("uses public Alchemy package entry points only", () => {
  const source = readFileSync(
    new URL("./external-sandbox-container-binding.ts", import.meta.url),
    "utf8",
  );

  expect(source).not.toMatch(/alchemy\/(?:lib|src)\//);
  expect(source).not.toMatch(/(?:Container|Worker)Provider/);
  expect(source).toContain('from "alchemy/Cloudflare"');
  expect(source).toContain('from "alchemy/Output"');
});
