import { assert, describe, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";
import {
  InstallationDeploymentError,
  uploadCredentialWrappingKey,
} from "../src/installation-deployment";
import { sanitizedChildEnvironment } from "../src/services.ts";

const KEY = "A".repeat(43);
const input = {
  accountId: "0123456789abcdef0123456789abcdef",
  scriptName: "scotty-home-worker",
  value: KEY,
};

describe("credential wrapping key upload", () => {
  it("scrubs legacy and Registry secrets from child environments", () => {
    assert.deepStrictEqual(
      sanitizedChildEnvironment({
        PATH: "/bin",
        GH_TOKEN: "legacy-github",
        PI_AUTH_JSON: "legacy-pi",
        CREDENTIAL_WRAPPING_KEY: KEY,
      }),
      { PATH: "/bin" },
    );
  });

  it.effect("uploads exactly once with the dedicated secret name", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      yield* uploadCredentialWrappingKey(input, (request) =>
        Effect.sync(() => {
          calls.push(request);
        }),
      );
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0], {
        accountId: input.accountId,
        scriptName: input.scriptName,
        name: "CREDENTIAL_WRAPPING_KEY",
        text: KEY,
        type: "secret_text",
      });
    }),
  );

  it.effect("returns a typed failure without retrying an ambiguous provider result", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* Effect.result(
        uploadCredentialWrappingKey(input, () => {
          calls += 1;
          return Effect.fail("provider outcome is ambiguous");
        }),
      );
      assert.strictEqual(calls, 1);
      assert.isTrue(Result.isFailure(result));
      const failure = Result.match(result, {
        onFailure: (cause) =>
          new InstallationDeploymentError({
            message: "Could not determine whether CREDENTIAL_WRAPPING_KEY was stored.",
            cause,
          }),
        onSuccess: () => new InstallationDeploymentError({ message: "unexpected success" }),
      });
      assert.isTrue(Predicate.isTagged(failure, "InstallationDeploymentError"));
      assert.strictEqual(
        failure.message,
        "Could not determine whether CREDENTIAL_WRAPPING_KEY was stored.",
      );
    }),
  );

  it.effect("does not call the provider when no key is supplied", () =>
    Effect.gen(function* () {
      let calls = 0;
      yield* uploadCredentialWrappingKey({ ...input, value: undefined }, () => {
        calls += 1;
        return Effect.void;
      });
      assert.strictEqual(calls, 0);
    }),
  );
});
