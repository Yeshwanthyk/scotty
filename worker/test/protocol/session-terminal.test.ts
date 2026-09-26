import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { SessionTerminalRestartedSchema } from "../../../protocol/session/session-terminal";

const decodeRestarted = Schema.decodeUnknownOption(SessionTerminalRestartedSchema, {
  onExcessProperty: "error",
});

describe("session terminal contract", () => {
  it("accepts only the bounded restart acknowledgement", () => {
    assert.isTrue(Option.isSome(decodeRestarted({ status: "restarted" })));
    assert.isTrue(Option.isNone(decodeRestarted({ status: "restarted", token: "secret" })));
    assert.isTrue(Option.isNone(decodeRestarted({ status: "ready" })));
  });
});
