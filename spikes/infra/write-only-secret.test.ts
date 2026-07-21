import { createHmac, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import { promisify } from "node:util";
import { assert, describe } from "@effect/vitest";
import { adopt } from "alchemy/AdoptPolicy";
import type { Plan } from "alchemy/Plan";
import { Stack } from "alchemy/Stack";
import { State, encodeState, type ResourceState } from "alchemy/State";
import * as Test from "alchemy/Test/Vitest";
import * as Cause from "effect/Cause";
import * as EffectConsole from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import {
  SecretSource,
  WriteOnlySecret,
  WriteOnlySecretDestination,
  type WriteOnlySecretAttributes,
  type WriteOnlySecretProps,
  writeOnlySecretProvider,
} from "./write-only-secret.ts";

type FailureMode =
  | "none"
  | "fail-before-write"
  | "fail-after-write"
  | "interrupt-before-write"
  | "interrupt-after-write";

interface SafeObservation {
  readonly operation: "read" | "write" | "delete";
  readonly destinationReference: string;
  readonly keyedDigest?: string;
  readonly outcome: string;
}

const digestKey = randomBytes(32);
const syntheticSourceId = `synthetic-source-${randomBytes(8).toString("hex")}`;
let syntheticPlaintext = randomBytes(48).toString("base64url");

const keyedDigest = (plaintext: string): string =>
  `hmac-sha256:v1:${createHmac("sha256", digestKey)
    .update("scotty-write-only-secret\0")
    .update(plaintext)
    .digest("hex")}`;

const destinationReference = (props: WriteOnlySecretProps): string =>
  `${props.accountId}/${props.scriptName}/${props.bindingName}`;

const destinationStore = new Map<string, WriteOnlySecretAttributes>();
const observations: SafeObservation[] = [];
let resolutions = 0;
let writes = 0;
let failureMode: FailureMode = "none";
const capturedLogs: unknown[][] = [];

const capturingConsole = new Proxy(console, {
  get(target, property) {
    if (property === "log") {
      return (...args: unknown[]) => {
        capturedLogs.push(args);
      };
    }
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as EffectConsole.Console;

const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(EffectConsole.Console, capturingConsole));

const mutateDestination = (metadata: WriteOnlySecretAttributes): void => {
  destinationStore.set(destinationReference(metadata), metadata);
  writes += 1;
};

const sourceLayer = Layer.succeed(SecretSource, {
  resolve: (sourceId) =>
    Effect.try(() => {
      resolutions += 1;
      // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: Effect.try test fake deliberately exercises a throwing synchronous source SDK
      if (sourceId !== syntheticSourceId) throw new Error("unknown source");
      return {
        plaintext: syntheticPlaintext,
        keyedDigest: keyedDigest(syntheticPlaintext),
      };
    }),
});

const destinationLayer = Layer.succeed(WriteOnlySecretDestination, {
  read: (key) =>
    Effect.sync(() => {
      const reference = destinationReference({
        ...key,
        sourceId: "",
        providerVersion: 0,
        keyedDigest: "",
      });
      const value = destinationStore.get(reference);
      observations.push({
        operation: "read",
        destinationReference: reference,
        keyedDigest: value?.keyedDigest,
        outcome: value === undefined ? "missing" : "found",
      });
      return value === undefined ? undefined : { ...value, leaked: syntheticPlaintext };
    }),
  write: (_key, { plaintext, metadata }) =>
    Effect.suspend(() => {
      const hostileFailure = () => Effect.fail(new Error(`synthetic adapter echoed ${plaintext}`));
      if (failureMode === "fail-before-write") return hostileFailure();
      if (failureMode === "interrupt-before-write") return Effect.interrupt;
      mutateDestination(metadata);
      observations.push({
        operation: "write",
        destinationReference: destinationReference(metadata),
        keyedDigest: metadata.keyedDigest,
        outcome: failureMode === "none" ? "written" : "ambiguous",
      });
      if (failureMode === "fail-after-write") return hostileFailure();
      if (failureMode === "interrupt-after-write") return Effect.interrupt;
      return Effect.succeed({ ...metadata, leaked: plaintext });
    }),
  delete: (key, ownerReference) =>
    Effect.try(() => {
      const reference = destinationReference({
        ...key,
        sourceId: "",
        providerVersion: 0,
        keyedDigest: "",
      });
      const live = destinationStore.get(reference);
      if (live !== undefined && live.ownerReference !== ownerReference) {
        // oxlint-disable-next-line scotty/no-raw-error-throw -- boundary: Effect.try test fake deliberately exercises a throwing synchronous destination SDK
        throw new Error("foreign owner");
      }
      destinationStore.delete(reference);
      observations.push({
        operation: "delete",
        destinationReference: reference,
        outcome: live === undefined ? "already-missing" : "deleted",
      });
    }),
});

const providers = writeOnlySecretProvider.pipe(
  Layer.provideMerge(Layer.merge(sourceLayer, destinationLayer)),
);
const { test } = Test.make({ providers });

const props = (): WriteOnlySecretProps => ({
  sourceId: syntheticSourceId,
  accountId: "synthetic-account",
  scriptName: "synthetic-worker",
  bindingName: "SYNTHETIC_TOKEN",
  providerVersion: 1,
  keyedDigest: keyedDigest(syntheticPlaintext),
});

const program = (desired: WriteOnlySecretProps) =>
  Effect.gen(function* () {
    const secret = yield* WriteOnlySecret("Secret", desired);
    return {
      sourceId: secret.sourceId,
      accountId: secret.accountId,
      scriptName: secret.scriptName,
      bindingName: secret.bindingName,
      providerVersion: secret.providerVersion,
      keyedDigest: secret.keyedDigest,
    };
  });

const adoptedProgram = (desired: WriteOnlySecretProps) =>
  Effect.gen(function* () {
    const secret = yield* WriteOnlySecret("Secret", desired).pipe(adopt(true));
    return {
      sourceId: secret.sourceId,
      accountId: secret.accountId,
      scriptName: secret.scriptName,
      bindingName: secret.bindingName,
      providerVersion: secret.providerVersion,
      keyedDigest: secret.keyedDigest,
    };
  });

const getState = Effect.fnUntraced(function* () {
  const state = yield* yield* State;
  const stack = yield* Stack;
  return (yield* state.get({
    stack: stack.name,
    stage: stack.stage,
    fqn: "Secret",
  })) as ResourceState | undefined;
});

const encodedForms = (plaintext: string): readonly string[] => [
  plaintext,
  Buffer.from(plaintext).toString("base64"),
  Buffer.from(plaintext).toString("base64url"),
  Buffer.from(plaintext).toString("hex"),
  encodeURIComponent(plaintext),
  JSON.stringify(plaintext).slice(1, -1),
];

const assertNoPlaintext = (label: string, plaintexts: readonly string[], value: unknown): void => {
  const rendered =
    typeof value === "string"
      ? value
      : inspect(value, {
          depth: Infinity,
          getters: false,
          maxArrayLength: Infinity,
          maxStringLength: Infinity,
        });
  for (const plaintext of plaintexts) {
    for (const encoded of encodedForms(plaintext)) {
      assert.ok(
        !rendered.includes(encoded),
        `${label} contained a forbidden synthetic credential encoding`,
      );
    }
  }
};

const planResource = (plan: Plan): unknown => plan.resources.Secret;

describe("M01B write-only Alchemy secret provider proof", () => {
  test.provider("keeps plaintext out of enumerated Alchemy lifecycle surfaces", (stack) =>
    Effect.gen(function* () {
      process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
      const plaintexts = [syntheticPlaintext];
      const surfaces: Array<readonly [string, unknown]> = [];

      const initialProps = props();
      const createPlan = yield* captureLogs(stack.plan(program(initialProps)));
      assert.equal(createPlan.resources.Secret?.action, "create");
      surfaces.push(["create props/news/plan", planResource(createPlan)]);

      const firstOutput = yield* captureLogs(stack.deploy(program(initialProps)));
      assert.equal(resolutions, 1);
      assert.equal(writes, 1);
      surfaces.push(["create output", firstOutput]);
      surfaces.push(["created state", encodeState(yield* getState())]);

      const noOpPlan = yield* captureLogs(stack.plan(program(initialProps)));
      assert.equal(noOpPlan.resources.Secret?.action, "noop");
      surfaces.push(["no-op plan", planResource(noOpPlan)]);
      yield* captureLogs(stack.deploy(program(initialProps)));
      assert.equal(resolutions, 1, "repeat reconcile must not resolve plaintext");
      assert.equal(writes, 1, "repeat reconcile must not write");

      syntheticPlaintext = randomBytes(48).toString("base64url");
      plaintexts.push(syntheticPlaintext);
      const updateProps = props();
      const updatePlan = yield* captureLogs(stack.plan(program(updateProps)));
      assert.equal(updatePlan.resources.Secret?.action, "update");
      surfaces.push(["update plan", planResource(updatePlan)]);
      yield* captureLogs(stack.deploy(program(updateProps)));
      assert.equal(resolutions, 2);
      assert.equal(writes, 2);
      surfaces.push(["updated state", encodeState(yield* getState())]);

      syntheticPlaintext = randomBytes(48).toString("base64url");
      plaintexts.push(syntheticPlaintext);
      const failedProps = props();
      failureMode = "fail-before-write";
      const failedExit = yield* Effect.exit(captureLogs(stack.deploy(program(failedProps))));
      assert.ok(Exit.isFailure(failedExit));
      const failedCause = Exit.isFailure(failedExit) ? Cause.pretty(failedExit.cause) : "";
      surfaces.push(["failed update exception", failedCause]);
      surfaces.push(["failed update state", encodeState(yield* getState())]);
      failureMode = "none";
      yield* captureLogs(stack.deploy(program(failedProps)));
      assert.equal(writes, 3, "retry after pre-write failure writes once");

      syntheticPlaintext = randomBytes(48).toString("base64url");
      plaintexts.push(syntheticPlaintext);
      const ambiguousFailureProps = props();
      failureMode = "fail-after-write";
      const resolutionsBeforeAmbiguousFailure = resolutions;
      const writesBeforeAmbiguousFailure = writes;
      const ambiguousFailureExit = yield* Effect.exit(
        captureLogs(stack.deploy(program(ambiguousFailureProps))),
      );
      assert.ok(Exit.isFailure(ambiguousFailureExit));
      surfaces.push([
        "ambiguous failed update exception",
        Exit.isFailure(ambiguousFailureExit) ? Cause.pretty(ambiguousFailureExit.cause) : "",
      ]);
      surfaces.push(["ambiguous failed update state", encodeState(yield* getState())]);
      failureMode = "none";
      yield* captureLogs(stack.deploy(program(ambiguousFailureProps)));
      assert.equal(resolutions, resolutionsBeforeAmbiguousFailure + 1);
      assert.equal(writes, writesBeforeAmbiguousFailure + 1);

      syntheticPlaintext = randomBytes(48).toString("base64url");
      plaintexts.push(syntheticPlaintext);
      const interruptedProps = props();
      failureMode = "interrupt-after-write";
      const resolutionsBeforeInterruption = resolutions;
      const writesBeforeInterruption = writes;
      const interruptedExit = yield* Effect.exit(
        captureLogs(stack.deploy(program(interruptedProps))),
      );
      assert.ok(Exit.isFailure(interruptedExit));
      surfaces.push([
        "interrupted update exception",
        Exit.isFailure(interruptedExit) ? Cause.pretty(interruptedExit.cause) : "",
      ]);
      surfaces.push(["interrupted update state", encodeState(yield* getState())]);
      assert.equal(resolutions, resolutionsBeforeInterruption + 1);
      assert.equal(writes, writesBeforeInterruption + 1);
      failureMode = "none";
      yield* captureLogs(stack.deploy(program(interruptedProps)));
      assert.equal(
        resolutions,
        resolutionsBeforeInterruption + 1,
        "retry after an ambiguous write must use safe live metadata",
      );
      assert.equal(
        writes,
        writesBeforeInterruption + 1,
        "retry after an ambiguous write must not rewrite",
      );

      const finalState = yield* getState();
      surfaces.push(["local/provider state", encodeState(finalState)]);
      surfaces.push(["provider observations", observations]);
      surfaces.push(["Alchemy Test LoggingCli progress", capturedLogs]);
      surfaces.push(["remote metadata response", [...destinationStore.values()]]);

      const providerSource = yield* Effect.tryPromise(() =>
        readFile(new URL("write-only-secret.ts", import.meta.url), "utf8"),
      );
      surfaces.push(["generated artifact source input", providerSource]);
      const bundlePath = "/tmp/scotty-m01b-proof.js";
      yield* Effect.tryPromise(() =>
        promisify(execFile)(
          "bun",
          [
            "build",
            "spikes/infra/write-only-secret.ts",
            "--target=node",
            "--external=@effect/platform-bun/*",
            `--outfile=${bundlePath}`,
          ],
          { cwd: new URL("../../", import.meta.url) },
        ),
      );
      surfaces.push([
        "generated bundle",
        yield* Effect.tryPromise(() => readFile(bundlePath, "utf8")),
      ]);

      yield* captureLogs(stack.destroy());
      assert.equal(yield* getState(), undefined);
      assert.equal(destinationStore.size, 0);
      assert.equal(
        resolutions,
        resolutionsBeforeInterruption + 1,
        "delete must not resolve plaintext",
      );
      surfaces.push(["delete result/state", encodeState(yield* getState())]);
      surfaces.push(["delete observations", observations]);

      const adoptionProps = props();
      destinationStore.set(destinationReference(adoptionProps), {
        ...adoptionProps,
        ownerReference: "synthetic-external-owner",
      });
      const writesBeforeAdoption = writes;
      const rejectedAdoptionPlan = yield* Effect.exit(
        captureLogs(stack.plan(program(adoptionProps))),
      );
      assert.ok(Exit.isFailure(rejectedAdoptionPlan));
      assert.equal(yield* getState(), undefined);
      assert.equal(writes, writesBeforeAdoption);
      surfaces.push([
        "adoption-disabled exception",
        Exit.isFailure(rejectedAdoptionPlan) ? Cause.pretty(rejectedAdoptionPlan.cause) : "",
      ]);
      const adoptionPlan = yield* captureLogs(stack.plan(adoptedProgram(adoptionProps)));
      assert.equal(adoptionPlan.resources.Secret?.action, "update");
      assert.equal(yield* getState(), undefined);
      surfaces.push(["adoption plan", planResource(adoptionPlan)]);
      const resolutionsBeforeAdoption = resolutions;
      const deletesBeforeFailedAdoption = observations.filter(
        ({ operation }) => operation === "delete",
      ).length;
      failureMode = "fail-before-write";
      const failedAdoptionExit = yield* Effect.exit(
        captureLogs(stack.deploy(adoptedProgram(adoptionProps))),
      );
      assert.ok(Exit.isFailure(failedAdoptionExit));
      surfaces.push([
        "failed adoption exception",
        Exit.isFailure(failedAdoptionExit) ? Cause.pretty(failedAdoptionExit.cause) : "",
      ]);
      surfaces.push(["failed adoption state", encodeState(yield* getState())]);
      const failedAdoptionDestroy = yield* Effect.exit(captureLogs(stack.destroy()));
      assert.ok(Exit.isFailure(failedAdoptionDestroy));
      assert.equal(
        observations.filter(({ operation }) => operation === "delete").length,
        deletesBeforeFailedAdoption,
      );
      assert.equal(
        destinationStore.get(destinationReference(adoptionProps))?.ownerReference,
        "synthetic-external-owner",
      );
      surfaces.push([
        "failed adoption destroy exception",
        Exit.isFailure(failedAdoptionDestroy) ? Cause.pretty(failedAdoptionDestroy.cause) : "",
      ]);
      failureMode = "none";
      yield* captureLogs(stack.deploy(adoptedProgram(adoptionProps)));
      assert.equal(
        resolutions,
        resolutionsBeforeAdoption + 2,
        "failed adoption and its retry each resolve once",
      );
      const adoptedState = yield* getState();
      const adoptedLive = destinationStore.get(destinationReference(adoptionProps));
      assert.ok(adoptedState !== undefined);
      assert.ok(adoptedLive !== undefined);
      assert.equal(writes, writesBeforeAdoption + 1);
      const expectedAdoptedOwner = `${adoptedState.fqn}#${adoptedState.instanceId}`;
      assert.equal(adoptedLive.ownerReference, expectedAdoptedOwner);
      assert.equal(
        adoptedLive.ownerReference,
        (adoptedState?.attr as WriteOnlySecretAttributes | undefined)?.ownerReference,
      );
      surfaces.push(["adopted state", encodeState(adoptedState)]);
      yield* captureLogs(stack.destroy());
      assert.equal(destinationStore.size, 0);
      surfaces.push(["final Effect metric telemetry snapshot", yield* Metric.dump]);

      for (const [label, surface] of surfaces) {
        assertNoPlaintext(label, plaintexts, surface);
      }
    }),
  );
});
