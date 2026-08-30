import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import {
  SessionTerminalRestartedSchema,
  sessionTerminalId,
} from "../../../protocol/session-terminal";

const decodeRestarted = Schema.decodeUnknownOption(SessionTerminalRestartedSchema, {
  onExcessProperty: "error",
});

describe("session terminal contract", () => {
  it("keeps the PTY identity deterministic and separate from the Scotty session", () => {
    assert.strictEqual(sessionTerminalId("a0b1c2d3e4f5"), "terminal-a0b1c2d3e4f5");
    assert.notStrictEqual(sessionTerminalId("a0b1c2d3e4f5"), "a0b1c2d3e4f5");
  });

  it("accepts only the bounded restart acknowledgement", () => {
    assert.isTrue(Option.isSome(decodeRestarted({ status: "restarted" })));
    assert.isTrue(Option.isNone(decodeRestarted({ status: "restarted", token: "secret" })));
    assert.isTrue(Option.isNone(decodeRestarted({ status: "ready" })));
  });
});
