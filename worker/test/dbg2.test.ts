import { describe, it } from "vitest";
import { Result, Schema } from "effect";
import { EnvironmentCredentialBindingSchema } from "../src/environment-contracts";

describe("dbg decode", () => {
  it("decodes binding", () => {
    const decode = Schema.decodeUnknownResult(EnvironmentCredentialBindingSchema, {
      onExcessProperty: "error",
    });
    const decoded = decode({ name: "OPENCODE_API_KEY", scheme: "bearer", value: "real-key" });
    console.log("IS_SUCCESS:", Result.isSuccess(decoded));
    if (Result.isFailure(decoded)) console.log("FAILURE:", JSON.stringify(decoded.failure));
  });
});
