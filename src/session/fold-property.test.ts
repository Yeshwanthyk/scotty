import { expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";
import { decodeSessionEvent } from "./events.js";
import { command } from "./commands.js";
import { deadline, fold, initial, type State } from "./fold.js";
import { live } from "./state.js";
import { check, created, generated, hello, kinds, ready, start } from "./fold-fixtures.js";

const supervisor = new Set([
  "workspace.ready",
  "agent.ready",
  "prompt.delivered",
  "agent.event",
  "turn.ended",
  "sup.error",
]);
const hits: Record<string, number> = {};
const bump = (name: string): void => {
  hits[name] = (hits[name] ?? 0) + 1;
};
let shortest = Infinity;
let longest = 0;

it.prop(
  "fold obeys output acceptance, acknowledgements, and pending-work deadlines",
  [Arbitrary.array(generated, { minLength: 20, maxLength: 200 })],
  ([steps]) => {
    shortest = Math.min(shortest, steps.length);
    longest = Math.max(longest, steps.length);
    for (const prefix of [[], [created, start, hello, ready]]) {
      let state: State = initial;
      let at = 4_000;
      let priorDial: number | undefined;
      for (const event of prefix) {
        state = fold(state, event);
        check(state);
      }
      for (const [index, step] of steps.entries()) {
        at += step.dt;
        const before = state;
        const gen = step.gen;
        const n = Math.max(1, before.lastN + step.dn);
        let kind: string = kinds[step.index] ?? "alarm";
        // Keep terminal events rare so later outputs and reconnects remain reachable.
        if (kind === "failed" && (step.req !== "p" || step.dn !== -1)) kind = "agent.event";
        const chosen =
          before.requests.find((r) =>
            step.target === "pending" ? r.status === "pending" : r.status !== "pending",
          )?.req ?? step.req;
        const turn = String(Math.max(0, Number(before.currentTurn) + step.turnOffset));
        const fields: Record<string, unknown> = {
          gen,
          n,
          req: chosen,
          turn,
          op: step.op,
          state: "completed",
          agentKind: "codex",
          repo: "https://example.org/repo",
          baseBranch: "main",
          base: "main",
          branch: "scotty/session-1",
          title: "test",
          prompt: "hello",
          image: "image",
          version: "v1",
          boot: step.bootFlip ? "boot-2" : "boot-1",
          commit: "abc",
          codexTurn: "cx-1",
          session: "thread-1",
          text: "go",
          images: [],
          event: null,
          phase: "boot",
          code: step.code,
          message: "supervisor output",
          retryable: false,
          detail: "detail",
        };
        if (kind === "alarm") {
          const due = deadline(before);
          const op = before.pending.find((p) => p.due === due)?.op;
          if (due === undefined || op === undefined) continue;
          at = Math.max(at, due);
          kind = "timeout";
          fields.op = op;
        }
        if (
          (kind === "prompt.requested" || kind === "interrupt.requested") &&
          (chosen.startsWith("initial:") || chosen.startsWith("stalled:"))
        )
          fields.req = "client-p";
        if (kind === "sup.error" && !step.withReq) delete fields.req;
        if (kind === "sup.hello") fields.n = 1;
        const event = decodeSessionEvent({
          seq: index + prefix.length + 1,
          at,
          src: "property",
          kind,
          ...fields,
        });
        state = fold(before, event);
        const issued = command(state, event);
        check(state);
        // Output numbering restarts with each resumed generation.
        if (state.gen === before.gen) expect(state.lastN).toBeGreaterThanOrEqual(before.lastN);
        if (!live(before) && !live(state)) expect(issued).toBeUndefined();
        if (!live(before) && live(state)) {
          expect(issued).toEqual({ kind: "container.start", gen: state.gen, fresh: true });
          bump("resume");
        }
        if (supervisor.has(event.kind) && "n" in event) {
          const accepted =
            live(before) && event.gen === before.gen && before.connected && event.n > before.lastN;
          if (accepted) {
            expect(state.lastN).toBe(event.n);
            bump(`accepted ${event.kind}`);
            if (event.n > before.lastN + 1) bump("n gap");
          } else {
            expect(state).toEqual({ ...before, lastSeq: event.seq });
            bump(before.connected ? "n duplicate or wrong gen" : "output while disconnected");
          }
          if (
            accepted &&
            state.lastN - before.lastAckN >= 50 &&
            !(event.kind === "workspace.ready" && !before.ready) &&
            live(state)
          ) {
            expect(["ack", "save"]).toContain(issued?.kind);
          }
        }
        if (event.kind === "sup.hello") {
          if (
            live(before) &&
            event.gen === before.gen &&
            before.boot !== undefined &&
            before.boot !== event.boot
          ) {
            expect(state).toMatchObject({ phase: "stopped", stop: { reason: "deploy" } });
            expect(issued).toEqual({ kind: "destroy" });
            bump("boot changed");
          } else if (before.connected) {
            expect(state).toEqual({ ...before, lastSeq: event.seq });
            expect(issued).toBeUndefined();
            bump("hello while connected");
          }
          if (issued?.kind === "resend")
            expect(issued.requests.map((r) => r.req)).toEqual(
              state.requests.filter((r) => r.status === "pending").map((r) => r.req),
            );
        }
        if (state.lastAckN !== before.lastAckN && state.gen === before.gen)
          expect(
            issued?.kind === "save" ? { kind: "ack", gen: issued.gen, ack: issued.ack } : issued,
          ).toEqual({ kind: "ack", gen: state.gen, ack: state.lastN });
        // A save carries the turn-end ack so one command both acks and saves.
        if (issued?.kind === "save") {
          expect(event.kind).toBe("turn.ended");
          expect(issued.ack).toBe(state.lastN);
          bump("save");
        }
        if (issued?.kind === "ack") {
          expect(issued.ack).toBe(state.lastN);
          expect(event.kind === "turn.ended" || state.lastN - before.lastAckN >= 50).toBe(true);
          bump(event.kind === "turn.ended" ? "ack turn" : "ack threshold");
        }
        if (issued?.kind === "dial")
          expect(
            event.kind === "sup.redial" ||
              (event.kind === "timeout" &&
                event.op === "redial" &&
                before.pending.some((p) => p.op === "redial" && p.due <= event.at)),
          ).toBe(true);
        for (const request of before.requests) {
          const status = state.requests.find((r) => r.req === request.req)?.status;
          if (request.status !== "pending") expect(status).toBe(request.status);
          if (event.kind === "sup.error" && event.code === "timeout")
            expect(status).toBe(request.status);
        }
        if (event.kind === "sup.error" && event.req !== undefined && state.lastN > before.lastN) {
          const target = before.requests.find((r) => r.req === event.req);
          if (target?.status === "pending") {
            expect(state.requests.find((r) => r.req === event.req)?.status).toBe(
              event.code === "timeout" ? "pending" : "failed",
            );
            bump(event.code === "timeout" ? "error pending timeout" : "error pending failed");
          } else if (target !== undefined) bump("error settled request");
        }
        if (event.kind === "turn.ended" && state.turns.length > before.turns.length)
          bump("turn advanced");
        if (issued?.kind === "idle") bump("idle");
        if (state.stop?.reason === "stalled" && live(before)) bump("stalled");
        if (event.kind === "sup.hello" && state.connected && !before.connected)
          bump(before.ready ? "reconnect ready" : "hello before ready");
        if (
          event.kind === "timeout" &&
          event.op.startsWith("req:") &&
          before.pending.some((p) => p.op === event.op && p.due <= event.at)
        )
          expect(state.requests.find((r) => `req:${r.req}` === event.op)?.status).toBe("timed_out");
        const dialDue = state.pending.find((p) => p.op === "dial")?.due;
        if (priorDial !== undefined && dialDue !== undefined)
          expect(dialDue).toBeLessThanOrEqual(priorDial);
        priorDial = dialDue;
      }
    }
  },
  { arbitrary: { runs: 200, seed: "fold-v2", size: 200 } },
);

it("covers generated paths", () => {
  expect(shortest).toBeGreaterThanOrEqual(20);
  expect(longest).toBeGreaterThanOrEqual(120);
  expect(hits["accepted agent.event"]).toBeGreaterThan(0);
  expect(hits["n gap"]).toBeGreaterThan(0);
  expect(hits["ack threshold"]).toBeGreaterThan(0);
  expect(hits["ack turn"]).toBeGreaterThan(0);
  expect(hits["save"]).toBeGreaterThan(0);
  expect(hits["resume"]).toBeGreaterThan(0);
  expect(hits["error pending failed"]).toBeGreaterThan(0);
  expect(hits["error settled request"]).toBeGreaterThan(0);
  expect(hits["idle"]).toBeGreaterThan(0);
  expect(hits["stalled"]).toBeGreaterThan(0);
});
