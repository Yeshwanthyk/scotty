import { describe, expect, it } from "@effect/vitest";
import { command } from "./commands.js";
import { deadlines, fold, initial, type State } from "./fold.js";
import { sessionView } from "./view.js";
import { check, created, make, start } from "./fold-fixtures.js";
import type { SessionEvent } from "./events.js";
import { threadGone } from "../../protocol/supervisor.js";

const handle = "session-1";
const marker = {
  session: "session-1",
  branch: "scotty/session-1",
  base: "abc",
  thread: "thread-1",
};

// Folds each event and checks the invariants after every one.
const run = (events: readonly SessionEvent[], from: State = initial): State =>
  events.reduce((state, event) => {
    const next = fold(state, event);
    check(next);
    return next;
  }, from);

// A running session on a machine, with a thread and, unless `save` is false, a save of its
// workspace. Ends at seq 8.
const running = (save = true): State =>
  run([
    created,
    start,
    make(3, "place.created", { gen: 1, handle }),
    make(4, "sup.hello", { gen: 1, version: "v1" }),
    make(5, "workspace.ready", { gen: 1, branch: "main", commit: "abc" }),
    make(6, "prompt.delivered", { req: "initial:1" }),
    make(7, "agent.ready", { gen: 1, n: 7, agentKind: "codex", session: "thread-1" }),
    save ? make(8, "save.done", { turn: "0" }) : make(8, "active"),
  ]);

// The owner stops it at seq 9; the place answers the pause at seq 10.
const rested = (save = true): State =>
  run(
    [
      make(9, "container.stopped", { gen: 1, reason: "user" }),
      make(10, "place.paused", { handle }),
    ],
    running(save),
  );

describe("place lifecycle", () => {
  it("creates a machine for a start and reaches it once the place answers", () => {
    const state = run([created, start]);
    expect(command(state, start)).toEqual({ kind: "create", gen: 1 });
    expect(state.place).toBeUndefined();
    const made = make(3, "place.created", { gen: 1, handle });
    const placed = run([made], state);
    expect(placed.place).toEqual({
      handle,
      gen: 1,
      size: "standard-1",
      status: "live",
      seq: 3,
    });
    // The create's caller goes on to reach the supervisor itself.
    expect(command(placed, made)).toBeUndefined();
    // A repeated answer changes nothing; another machine is let go.
    expect(fold(placed, { ...made, seq: 4 }).place).toEqual(placed.place);
    const other = make(4, "place.created", { gen: 1, handle: "other" });
    expect(command(fold(placed, other), other)).toEqual({ kind: "discard", handle: "other" });
  });

  it("pauses the machine on a stop and keeps it once the place answers", () => {
    const stop = make(9, "container.stopped", { gen: 1, reason: "user" });
    let state = run([stop], running());
    expect(state).toMatchObject({ phase: "stopped", stop: { reason: "user" } });
    expect(state.place).toMatchObject({ handle, status: "pausing", seq: 9 });
    expect(state.pending).toEqual([{ op: "pause", due: 9_000 + deadlines.pause }]);
    expect(command(state, stop)).toEqual({ kind: "pause", handle });
    const paused = make(10, "place.paused", { handle });
    state = run([paused], state);
    expect(state.place).toMatchObject({ handle, status: "paused" });
    expect(state.pending).toEqual([]);
    expect(command(state, paused)).toBeUndefined();
    expect(sessionView("s", state).authority).toMatchObject({ lifecycle: "stopped" });
  });

  it("removes the machine when an automation's session ends", () => {
    const end = make(9, "container.stopped", { gen: 1, reason: "ended" });
    const state = run([end], running());
    expect(state.place).toBeUndefined();
    expect(state.gone).toEqual({ handle, seq: 9 });
    expect(state.pending).toEqual([]);
    expect(command(state, end)).toEqual({ kind: "remove", handle });
  });

  it("asks the place again when a pause's answer is lost", () => {
    let state = run([make(9, "container.stopped", { gen: 1, reason: "user" })], running());
    const lost = make(10, "timeout", { op: "pause" });
    state = run([{ ...lost, at: 9_000 + deadlines.pause }], state);
    expect(command(state, { ...lost, at: 9_000 + deadlines.pause })).toEqual({
      kind: "check",
      handle,
    });
    // Still pausing, under a new deadline, until the place answers.
    expect(state.place).toMatchObject({ status: "pausing", seq: 10 });
    expect(state.pending).toEqual([{ op: "pause", due: 9_000 + 2 * deadlines.pause }]);
    state = run([make(11, "place.paused", { handle })], state);
    expect(state.place?.status).toBe("paused");
    expect(state.pending).toEqual([]);
    // A late answer for a pause that's settled does nothing.
    const late = make(12, "timeout", { op: "pause" });
    expect(command(run([late], state), late)).toBeUndefined();
  });

  it("wakes a machine still pausing only once its place answers", () => {
    const stopped = run([make(9, "container.stopped", { gen: 1, reason: "user" })], running());
    const resumed = make(10, "resume.requested");
    let state = run([resumed], stopped);
    expect(state).toMatchObject({ phase: "provisioning", gen: 2 });
    expect(state.place?.status).toBe("pausing");
    expect(command(state, resumed)).toBeUndefined();
    // Paused: the woken session wakes it.
    const paused = make(11, "place.paused", { handle });
    const woken = run([paused], state);
    expect(woken.place).toMatchObject({ status: "live", gen: 1 });
    expect(command(woken, paused)).toEqual({ kind: "resume", gen: 2, handle });
    // Gone: the woken session makes a new machine, removing the old one first.
    const gone = make(11, "place.gone", { handle });
    state = run([gone], state);
    expect(state).toMatchObject({ phase: "provisioning", gen: 2, place: undefined });
    expect(command(state, gone)).toEqual({ kind: "create", gen: 2, remove: handle });
  });

  it("restores on a new machine when the rested one is gone", () => {
    const resumed = make(11, "resume.requested");
    let state = run([resumed], rested());
    expect(command(state, resumed)).toEqual({ kind: "resume", gen: 2, handle });
    const gone = make(12, "place.gone", { handle });
    state = run([gone], state);
    expect(state).toMatchObject({ phase: "provisioning", gen: 2, place: undefined });
    expect(command(state, gone)).toEqual({ kind: "create", gen: 2, remove: handle });
    const made = make(13, "place.created", { gen: 2, handle });
    state = run([made], state);
    expect(state.gone).toBeUndefined();
    const greeting = make(14, "sup.hello", { gen: 2, version: "v1", boot: "boot-2" });
    state = run([greeting], state);
    // A new disk: the start restores from the save.
    const begin = command(state, greeting);
    expect(begin).toMatchObject({ kind: "start", gen: 2, resume: { threadId: "thread-1" } });
    expect(begin).not.toHaveProperty("fromDisk");
  });

  it("starts from the kept disk when the woken machine's marker is this session's", () => {
    let state = run(
      [
        make(11, "resume.requested"),
        make(12, "sup.hello", { gen: 2, version: "v1", workspace: marker }),
      ],
      rested(),
    );
    expect(state).toMatchObject({ gen: 2, hello: true, fromDisk: true });
    expect(state.place).toMatchObject({ handle, gen: 2, status: "live" });
    const greeting = make(12, "sup.hello", { gen: 2, version: "v1", workspace: marker });
    expect(command(state, greeting)).toEqual({
      kind: "start",
      gen: 2,
      repo: "https://example.org/repo",
      base: "main",
      branch: "scotty/session-1",
      agentKind: "codex",
      resume: { threadId: "thread-1", commit: "abc" },
      fromDisk: true,
    });
    state = run(
      [make(13, "workspace.ready", { gen: 2, n: 2, branch: "main", commit: "abc" })],
      state,
    );
    expect(state.phase).toBe("running");
  });

  it("replaces a woken machine whose disk is not this session's", () => {
    for (const workspace of [
      undefined,
      { ...marker, base: "def" },
      { ...marker, session: "session-2", branch: "scotty/session-2" },
      { ...marker, thread: "thread-2" },
    ]) {
      const greeting = make(12, "sup.hello", {
        gen: 2,
        version: "v1",
        ...(workspace === undefined ? {} : { workspace }),
      });
      const state = run([make(11, "resume.requested"), greeting], rested());
      expect(state).toMatchObject({ phase: "provisioning", gen: 3, hello: false, fromDisk: false });
      expect(state.place).toBeUndefined();
      expect(state.gone).toEqual({ handle, seq: 12 });
      expect(command(state, greeting)).toEqual({ kind: "create", gen: 3, remove: handle });
    }
  });

  it("replaces a woken machine whose agent can't resume its thread", () => {
    let state = run(
      [
        make(11, "resume.requested"),
        make(12, "sup.hello", { gen: 2, version: "v1", workspace: marker }),
      ],
      rested(),
    );
    const refused = make(13, "sup.error", { gen: 2, n: 2, code: threadGone, message: "no thread" });
    state = run([refused], state);
    expect(state).toMatchObject({
      phase: "provisioning",
      gen: 3,
      fromDisk: false,
      place: undefined,
    });
    expect(command(state, refused)).toEqual({ kind: "create", gen: 3, remove: handle });
    // On a new disk the same error fails the start as any other does.
    const fresh = run(
      [
        make(14, "place.created", { gen: 3, handle }),
        make(15, "sup.hello", { gen: 3, version: "v1", boot: "boot-3" }),
        make(16, "sup.error", { gen: 3, n: 2, code: threadGone, message: "no thread" }),
      ],
      state,
    );
    expect(fresh.phase).toBe("failed");
  });

  it("pauses, and does not remove, a machine whose supervisor restarted", () => {
    const changed = make(9, "sup.hello", { gen: 1, version: "v1", boot: "boot-2" });
    const state = run([changed], running());
    expect(state).toMatchObject({ phase: "stopped", stop: { reason: "deploy" }, gone: undefined });
    expect(state.place).toMatchObject({ handle, status: "pausing" });
    expect(command(state, changed)).toEqual({ kind: "pause", handle });
  });

  it("stops gone, never reported resumed, when nothing could restore the session", () => {
    // A rested machine with no save: woken it serves; gone, there is nothing to restore.
    const resumed = make(11, "resume.requested");
    let state = run([resumed], rested(false));
    expect(command(state, resumed)).toEqual({ kind: "resume", gen: 2, handle });
    state = run([make(12, "place.gone", { handle })], state);
    expect(state).toMatchObject({ phase: "stopped", stop: { reason: "gone" }, place: undefined });
    // With no machine and no save, a resume or a prompt only says why it can't wake.
    const again = make(13, "resume.requested");
    state = run([again], state);
    expect(state).toMatchObject({ phase: "stopped", stop: { reason: "gone" } });
    expect(command(state, again)).toBeUndefined();
    const prompt = make(14, "prompt.requested", {
      req: "p",
      turn: state.currentTurn,
      text: "go on",
      images: [],
    });
    state = run([prompt], state);
    expect(state.phase).toBe("stopped");
    expect(state.requests.find((item) => item.req === "p")?.status).toBe("stale");
    expect(command(state, prompt)).toBeUndefined();
  });

  it("removes a kept machine of another size before making one at the new size", () => {
    const sized = make(11, "resume.requested", { size: "standard-3" });
    const state = run([sized], rested());
    expect(state).toMatchObject({ phase: "provisioning", gen: 2, size: "standard-3" });
    expect(state.place).toBeUndefined();
    expect(command(state, sized)).toEqual({ kind: "create", gen: 2, remove: handle });
  });

  it("stamps how long each step of a wake took", () => {
    const state = run(
      [
        make(11, "resume.requested"),
        make(12, "sup.hello", { gen: 2, version: "v1", workspace: marker }),
        make(13, "workspace.ready", { gen: 2, n: 2, branch: "main", commit: "abc" }),
      ],
      rested(),
    );
    expect(state.timings).toEqual({ gen: 2, start: 11_000, hello: 12_000, ready: 13_000 });
    expect(sessionView("s", state).start).toMatchObject({ gen: 2, hello: 1_000, ready: 2_000 });
  });
});
