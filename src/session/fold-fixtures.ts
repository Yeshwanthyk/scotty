import { expect } from "@effect/vitest";
import { Schema } from "effect";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";
import { decodeSessionEvent, type SessionEvent } from "./events.js";
import { deadline, fold, initial, invariants, type State } from "./fold.js";
import { live } from "./state.js";

const supervisorKinds = new Set([
  "sup.hello",
  "workspace.ready",
  "agent.ready",
  "prompt.delivered",
  "agent.event",
  "turn.ended",
  "sup.error",
]);
export const make = (
  seq: number,
  kind: string,
  fields: Record<string, unknown> = {},
): SessionEvent =>
  decodeSessionEvent({
    seq,
    at: seq * 1_000,
    src: "test",
    kind,
    ...(supervisorKinds.has(kind)
      ? {
          gen: 1,
          n: kind === "sup.hello" ? 1 : seq,
          boot: "boot-1",
          codexTurn: "codex-0",
          session: "session-1",
          base: "main",
          message: "error",
          code: "error",
        }
      : {}),
    ...fields,
  });
export const created = make(1, "created", {
  agentKind: "codex",
  repo: "https://example.org/repo",
  baseBranch: "main",
  branch: "scotty/session-1",
  title: "test",
  prompt: "hello",
  image: "image",
});
export const start = make(2, "container.start", { gen: 1 });
export const hello = make(3, "sup.hello", { gen: 1, version: "v1" });
export const ready = make(4, "workspace.ready", { gen: 1, branch: "main", commit: "abc" });
export const delivered = make(5, "prompt.delivered", { req: "initial:1" });
export const boot = (): State => [created, start, hello, ready, delivered].reduce(fold, initial);

export const check = (state: State): void => {
  expect(invariants(state)).toEqual([]);
  const pending = state.pending;
  expect(deadline(state)).toBe(
    pending.length === 0 ? undefined : Math.min(...pending.map((item) => item.due)),
  );
  expect(pending.some((p) => p.op === "container")).toBe(
    state.gen !== undefined && !state.hello && live(state),
  );
  expect(pending.some((p) => p.op === "workspace")).toBe(
    state.hello && !state.ready && live(state),
  );
  expect(pending.some((p) => p.op === "dial")).toBe(state.hello && !state.connected && live(state));
  for (const request of state.requests)
    expect(pending.some((p) => p.op === `req:${request.req}`)).toBe(
      request.status === "pending" && state.ready,
    );
};

export const kinds = [
  "created",
  "container.start",
  "sup.hello",
  "sup.hello",
  "sup.hello",
  "workspace.ready",
  "workspace.ready",
  "agent.ready",
  "prompt.requested",
  "prompt.requested",
  "prompt.delivered",
  "prompt.delivered",
  "interrupt.requested",
  "agent.event",
  "agent.event",
  "agent.event",
  "agent.event",
  "turn.ended",
  "sup.error",
  "sup.error",
  "timeout",
  "alarm",
  "alarm",
  "socket.closed",
  "dial.failed",
  "sup.redial",
  "failed",
  "active",
  "invariant.violated",
] as const;
export const generated = Arbitrary.schema(
  Schema.Struct({
    index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: kinds.length - 1 })),
    gen: Schema.Literals([0, 1, 1, 1, 1, 2]),
    dn: Schema.Literals([-1, 0, 1, 1, 2, 5, 49, 50]),
    bootFlip: Schema.Literals([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]),
    req: Schema.Literals(["p", "q", "r", "s", "t", "initial:1"]),
    target: Schema.Literals(["pending", "settled", "random"]),
    turnOffset: Schema.Literals([-1, 0, 0, 0, 1]),
    code: Schema.Literals(["timeout", "stale", "protocol", "exit"]),
    withReq: Schema.Boolean,
    op: Schema.Literals(["container", "workspace", "dial", "redial", "req:p", "req:initial:1"]),
    dt: Schema.Literals([0, 1_000, 2_000, 30_000, 120_000]),
  }),
);
