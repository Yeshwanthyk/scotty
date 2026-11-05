import { expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";
import { decodeSessionEvent } from "./events.js";
import { command } from "./commands.js";
import { deadline, fold, initial, resizeConflict, type State } from "./fold.js";
import { live } from "./state.js";
import {
  check,
  created,
  delivered,
  generated,
  hello,
  kinds,
  make,
  ready,
  start,
} from "./fold-fixtures.js";

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
// What a stop sends: pause the machine it just let rest, remove one it let go, or only free the slot.
const stopped = (state: State, seq: number) =>
  state.place?.status === "pausing" && state.place.seq === seq
    ? { kind: "pause", handle: state.place.handle }
    : state.gone?.seq === seq
      ? { kind: "remove", handle: state.gone.handle }
      : { kind: "release" };
let shortest = Infinity;
let longest = 0;

it.prop(
  "fold obeys output acceptance, acknowledgements, pending-work deadlines and one size",
  [Arbitrary.array(generated, { minLength: 20, maxLength: 200 })],
  ([steps]) => {
    shortest = Math.min(shortest, steps.length);
    longest = Math.max(longest, steps.length);
    for (const prefix of [
      [],
      [created, start, hello, ready],
      [created, start, hello, ready, delivered],
      // A machine that holds the session's thread, so a wake can find it on disk.
      [
        created,
        start,
        make(3, "place.created", { gen: 1, handle: "session-1" }),
        { ...hello, seq: 4 },
        { ...ready, seq: 5 },
        make(6, "agent.ready", { gen: 1, n: 6, agentKind: "codex", session: "thread-1" }),
      ],
    ]) {
      let state: State = initial;
      let at = 4_000;
      let priorDial: number | undefined;
      // Generations whose start was refused by the cap; none of their output may land.
      const capped = new Set<number>();
      // The first `created` event's size, then the last applied resume's that named one.
      let size: string = "standard-1";
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
        // The first prompt keeps its `initial:<gen>` name, which the generated requests use.
        if (kind === "created") delete fields.req;
        if ((kind === "created" || kind === "resume.requested") && step.size !== "none")
          fields.size = step.size;
        if (kind === "sup.error" && !step.withReq) delete fields.req;
        if (kind === "sup.hello") {
          fields.n = 1;
          // A machine reporting its disk greets the generation that woke it.
          if (step.disk === "kept" && before.gen !== undefined) fields.gen = before.gen;
          if (step.disk !== "none")
            fields.workspace = {
              session: "session-1",
              branch: "scotty/session-1",
              base: step.disk === "kept" ? "abc" : "def",
              thread: "thread-1",
            };
        }
        if (kind.startsWith("place.")) {
          fields.handle = step.handle;
          delete fields.req;
        }
        if (kind === "stop") {
          kind = "container.stopped";
          fields.reason = "user";
          delete fields.req;
        }
        const cap = kind === "cap";
        if (cap) {
          kind = "container.stopped";
          fields.reason = "cap";
          fields.max = 2;
          delete fields.req;
        }
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
        if (event.kind === "created" && before.created === undefined) {
          size = event.size ?? "standard-1";
          bump(event.size === undefined ? "created without size" : "created with size");
        }
        if (event.kind === "resume.requested") {
          // A resume is taken by a session at rest that could resume; one with nothing to wake
          // from stops gone instead of starting.
          const woke = !live(before) && live(state);
          const applied =
            woke ||
            (!live(before) &&
              (before.phase === "stopped" || before.failure?.retryable === true) &&
              state.stop?.reason === "gone");
          if (applied && event.size !== undefined) size = event.size;
          if (applied && !woke) bump("resume with nothing to wake");
          bump(
            `resume ${applied ? "applied" : "ignored"} ${event.size === undefined ? "without" : "with"} size`,
          );
          // The API refuses exactly the sized resumes the fold would ignore and that change size.
          expect(resizeConflict(before, event.size)).toBe(
            applied || event.size === undefined || event.size === before.size
              ? undefined
              : before.phase === "failed"
                ? "failed"
                : "running",
          );
        }
        expect(state.size).toBe(size);
        // A running container never changes size.
        if (before.created !== undefined && live(before)) expect(state.size).toBe(before.size);
        // Output numbering restarts with each resumed generation.
        if (state.gen === before.gen) expect(state.lastN).toBeGreaterThanOrEqual(before.lastN);
        // A session at rest only settles its machine: a late create, a pause the place has not
        // answered, or an owner's stop of a failed session.
        if (!live(before) && !live(state))
          expect([undefined, "pause", "remove", "check", "discard", "release"]).toContain(
            issued?.kind,
          );
        if (!live(before) && !live(state) && issued?.kind === "release")
          expect(event.kind).toBe("container.stopped");
        if (cap) {
          if (live(before) && before.gen === gen) {
            expect(state).toMatchObject({ phase: "stopped", stop: { reason: "cap", max: 2 } });
            expect(state.pending.filter((item) => item.op !== "pause")).toEqual([]);
            expect(issued).toEqual(stopped(state, event.seq));
            capped.add(gen);
            bump(before.hello ? "cap" : "cap at start");
          } else expect(state).toEqual({ ...before, lastSeq: event.seq });
        }
        if (supervisor.has(event.kind) && "gen" in event && capped.has(event.gen)) {
          expect(state.lastN).toBe(before.lastN);
          bump("output after cap");
        }
        if (!live(before) && live(state)) {
          // A wake makes a machine, wakes the rested one, or waits for one still pausing.
          const place = state.place;
          expect(issued).toEqual(
            place === undefined
              ? {
                  kind: "create",
                  gen: state.gen,
                  ...(state.gone === undefined ? {} : { remove: state.gone.handle }),
                }
              : place.status === "pausing"
                ? undefined
                : { kind: "resume", gen: state.gen, handle: place.handle },
          );
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
            // A boot change pauses the machine: the place keeps it.
            expect(issued).toEqual(stopped(state, event.seq));
            expect(issued?.kind).not.toBe("remove");
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
          // A request timeout stays pending; a req-less startup error ends the session.
          if (event.kind === "sup.error" && event.req !== undefined && event.code === "timeout")
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
        if (issued !== undefined && issued.kind !== "save" && issued.kind !== "ack")
          bump(`issued ${issued.kind}`);
        // Only the place's own answer lets a machine go, and a stop never leaves one live.
        if (state.place === undefined && before.place !== undefined)
          expect(
            event.kind === "place.gone" ||
              event.kind === "sup.hello" ||
              event.kind === "sup.error" ||
              state.gone?.handle === before.place.handle,
          ).toBe(true);
        if (!live(state)) expect(state.place?.status).not.toBe("live");
        if (state.fromDisk && !before.fromDisk) bump("woken from disk");
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
  expect(hits["cap at start"]).toBeGreaterThan(0);
  expect(hits["output after cap"]).toBeGreaterThan(0);
  expect(hits["created without size"]).toBeGreaterThan(0);
  expect(hits["created with size"]).toBeGreaterThan(0);
  expect(hits["resume applied with size"]).toBeGreaterThan(0);
  expect(hits["resume applied without size"]).toBeGreaterThan(0);
  expect(hits["resume ignored with size"]).toBeGreaterThan(0);
  expect(hits["resume with nothing to wake"]).toBeGreaterThan(0);
  for (const kind of ["create", "resume", "connect", "pause", "remove", "check", "discard"])
    expect(hits[`issued ${kind}`], kind).toBeGreaterThan(0);
  expect(hits["woken from disk"]).toBeGreaterThan(0);
});
