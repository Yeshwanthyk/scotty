import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { RuntimeCliMaterializationFailure } from "../../src/runtime-cli/materializer";
import type { RuntimeCliPin } from "../../../protocol/runtime-cli-pin";
import type { SessionAuthority } from "../../src/session-actor/authority";
import {
  CREATE_IDEMPOTENCY,
  CREATE_INPUT,
  createSessionHarness,
  SESSION_ID,
  sessionHarnessKeys,
} from "../support/session-harness";
import { runtimeCliPin } from "./fixtures";

const nextPin: RuntimeCliPin = {
  ...runtimeCliPin,
  descriptor: {
    ...runtimeCliPin.descriptor,
    releaseTag: "v0.3.20",
    artifact: {
      ...runtimeCliPin.descriptor.artifact,
      cliVersion: "0.3.20",
      sha256: "e".repeat(64),
    },
  },
};

describe("Session-owned runtime CLI pin", () => {
  it("admission/replay/sleep/resume keep exact pin without looking up latest", async () => {
    let active = runtimeCliPin;
    const installed: Array<RuntimeCliPin | undefined> = [];
    const harness = await createSessionHarness({
      readRuntimeCli: () => active,
      runtimeCliMaterializer: {
        materialize: (_id, pin) =>
          Effect.sync(() => {
            installed.push(pin);
          }),
      },
    });
    const created = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );
    assert.equal(created.status, "warm");
    active = nextPin;
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    await harness.sandbox.sleepScottySession();
    const resumed = await harness.sandbox.resumeScottySession();
    assert.equal(resumed.status, "warm");
    assert.equal(harness.events.filter((event) => event === "runtime-cli:select").length, 1);
    assert.deepEqual(installed, [runtimeCliPin, runtimeCliPin]);
    assert.deepEqual(
      harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority)?.session.configuration
        ?.runtimeCli,
      runtimeCliPin,
    );
    const later = await createSessionHarness({ readRuntimeCli: () => active });
    await later.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    assert.deepEqual(
      later.read<SessionAuthority>(sessionHarnessKeys.actorAuthority)?.session.configuration
        ?.runtimeCli,
      nextPin,
    );
  });
  for (const agent of ["pi", "codex"] as const) {
    it(`failed managed install prevents ${agent} supervisor readiness`, async () => {
      let materializations = 0;
      const harness = await createSessionHarness({
        runtimeCliMaterializer: {
          materialize: () =>
            Effect.sync(() => {
              materializations++;
            }).pipe(
              Effect.andThen(
                Effect.fail(new RuntimeCliMaterializationFailure({ reason: "runtime" })),
              ),
            ),
        },
      });
      const result = await harness.sandbox
        .createScottySession(
          {
            ...CREATE_INPUT,
            selection: agent === "pi" ? { agent } : { agent, model: "gpt-5.4", effort: "high" },
          },
          SESSION_ID,
          CREATE_IDEMPOTENCY,
        )
        .then(
          (value) => value,
          () => undefined,
        );
      assert.notEqual(result?.status, "warm");
      assert.isFalse(harness.events.some((event) => event.startsWith("host:pi:start:")));
      assert.equal(materializations, 1);
    });
  }
  it("missing immutable bytes block restore, even if backup contains the old binary", async () => {
    let missing = false;
    const harness = await createSessionHarness({
      runtimeCliMaterializer: {
        materialize: () =>
          missing
            ? Effect.fail(new RuntimeCliMaterializationFailure({ reason: "missing_artifact" }))
            : Effect.void,
      },
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    await harness.sandbox.sleepScottySession();
    missing = true;
    const before = harness.events.filter((event) => event.startsWith("host:pi:start:")).length;
    const result = await harness.sandbox.resumeScottySession().then(
      (value) => value,
      () => undefined,
    );
    assert.notEqual(result?.status, "warm");
    assert.equal(
      harness.events.filter((event) => event.startsWith("host:pi:start:")).length,
      before,
    );
    assert.equal(harness.events.filter((event) => event === "runtime-cli:select").length, 1);
  });
});
