import { describe, expect, it, vi } from "vitest";
import type { PiConsoleCommandV1, PiConsoleEventEnvelopeV1 } from "../../protocol/pi-console.ts";
import { commandIntentDigest } from "../../protocol/pi-console-shared.mjs";
import type { DesktopFrame } from "../src/desktop-protocol.ts";
import { makeDesktopSidecar } from "../src/desktop-sidecar.ts";
import type { CommandResult, ConsoleTransport } from "../src/transport.ts";
import { SESSION_A, SESSION_B, session, snapshot } from "./fixtures.ts";

class FakeDesktopTransport implements ConsoleTransport {
  readonly commands: PiConsoleCommandV1[] = [];
  readonly reads: string[] = [];

  readonly listFleet = async () => {
    this.reads.push("fleet");
    return [session(SESSION_A), session(SESSION_B)];
  };

  readonly getSelected = async (sessionId: string) => {
    this.reads.push(`selected:${sessionId}`);
    return session(sessionId);
  };

  readonly getSnapshot = async (sessionId: string) => {
    this.reads.push(`snapshot:${sessionId}`);
    return snapshot(sessionId === SESSION_A ? 7 : 11);
  };

  readonly streamEvents = async function* (
    _sessionId: string,
    _epoch: string,
    _since: number,
    signal: AbortSignal,
  ): AsyncIterable<PiConsoleEventEnvelopeV1> {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    yield* [];
  };

  readonly postCommand = async (
    _sessionId: string,
    command: PiConsoleCommandV1,
  ): Promise<CommandResult> => {
    this.commands.push(command);
    return {
      version: 1,
      epoch: command.epoch,
      commandId: command.commandId,
      commandDigest: await commandIntentDigest(command.intent),
      status: "accepted",
      response: { success: true },
    };
  };
}

const latestState = (frames: ReadonlyArray<DesktopFrame>) =>
  [...frames].reverse().find((frame) => frame.type === "state")?.state;

describe("desktop sidecar", () => {
  it("streams fleet and selected state without mutating remote lifecycle", async () => {
    const transport = new FakeDesktopTransport();
    const frames: DesktopFrame[] = [];
    const sidecar = makeDesktopSidecar(transport, (frame) => frames.push(frame));

    await sidecar.start();
    expect(frames[0]).toEqual({ version: 1, type: "ready" });
    expect(latestState(frames)?.fleet.map((entry) => entry.id)).toEqual([SESSION_A, SESSION_B]);

    await sidecar.handleLine(JSON.stringify({ version: 1, type: "select", sessionId: SESSION_B }));
    expect(latestState(frames)?.selectedSessionId).toBe(SESSION_B);
    await vi.waitFor(() => expect(latestState(frames)?.selected?.live?.sessionRevision).toBe(11));
    expect(transport.commands).toEqual([]);
    expect(transport.reads).toContain(`snapshot:${SESSION_B}`);
    sidecar.stop();
  });

  it("routes submit through the existing fenced controller", async () => {
    const transport = new FakeDesktopTransport();
    const frames: DesktopFrame[] = [];
    const sidecar = makeDesktopSidecar(transport, (frame) => frames.push(frame));
    await sidecar.start();
    await sidecar.handleLine(JSON.stringify({ version: 1, type: "select", sessionId: SESSION_A }));
    await vi.waitFor(() => expect(latestState(frames)?.selected?.live).toBeDefined());
    await sidecar.handleLine(
      JSON.stringify({
        version: 1,
        type: "submit",
        sessionId: SESSION_A,
        expectedEpoch: "epoch-1",
        expectedSessionRevision: 7,
        text: "ship the slice",
      }),
    );

    expect(transport.commands).toHaveLength(1);
    expect(transport.commands[0]).toMatchObject({
      version: 1,
      epoch: "epoch-1",
      expectedSessionRevision: 7,
      intent: { type: "prompt", message: "ship the slice" },
    });
    expect(latestState(frames)?.selected?.commandStatus).toBe("Command accepted");

    await sidecar.handleLine(
      JSON.stringify({
        version: 1,
        type: "submit",
        sessionId: SESSION_B,
        expectedEpoch: "epoch-1",
        expectedSessionRevision: 7,
        text: "must not cross sessions",
      }),
    );
    expect(transport.commands).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      code: "command_failed",
      message: "Desktop selection changed; retry the command",
    });
    sidecar.stop();
  });

  it("rejects commands from an old epoch or session revision", async () => {
    const transport = new FakeDesktopTransport();
    const frames: DesktopFrame[] = [];
    const sidecar = makeDesktopSidecar(transport, (frame) => frames.push(frame));
    await sidecar.start();
    await sidecar.handleLine(JSON.stringify({ version: 1, type: "select", sessionId: SESSION_A }));
    await vi.waitFor(() => expect(latestState(frames)?.selected?.live).toBeDefined());

    for (const fence of [
      { expectedEpoch: "old-epoch", expectedSessionRevision: 7 },
      { expectedEpoch: "epoch-1", expectedSessionRevision: 6 },
    ]) {
      await sidecar.handleLine(
        JSON.stringify({
          version: 1,
          type: "submit",
          sessionId: SESSION_A,
          ...fence,
          text: "stale command",
        }),
      );
      expect(frames.at(-1)).toMatchObject({
        type: "error",
        code: "command_failed",
        message: "Desktop session changed; retry the command",
      });
    }

    expect(transport.commands).toEqual([]);
    sidecar.stop();
  });

  it("keeps draft edits local without publishing a state frame per keystroke", async () => {
    const frames: DesktopFrame[] = [];
    const sidecar = makeDesktopSidecar(new FakeDesktopTransport(), (frame) => frames.push(frame));
    await sidecar.start();
    await sidecar.handleLine(JSON.stringify({ version: 1, type: "select", sessionId: SESSION_A }));
    await vi.waitFor(() => expect(latestState(frames)?.selected?.live).toBeDefined());
    const stateFrames = frames.filter((frame) => frame.type === "state").length;

    await sidecar.handleLine(
      JSON.stringify({
        version: 1,
        type: "set_draft",
        sessionId: SESSION_A,
        text: "local draft",
      }),
    );

    expect(frames.filter((frame) => frame.type === "state")).toHaveLength(stateFrames);
    sidecar.stop();
  });

  it("lets a newer selection or close supersede an in-flight selection", async () => {
    const transport = new FakeDesktopTransport();
    const frames: DesktopFrame[] = [];
    const sidecar = makeDesktopSidecar(transport, (frame) => frames.push(frame));
    await sidecar.start();

    await sidecar.handleLine(JSON.stringify({ version: 1, type: "select", sessionId: SESSION_A }));
    await sidecar.handleLine(JSON.stringify({ version: 1, type: "select", sessionId: SESSION_B }));
    await sidecar.handleLine(JSON.stringify({ version: 1, type: "close" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(latestState(frames)?.selectedSessionId).toBeUndefined();
    expect(transport.commands).toEqual([]);
    sidecar.stop();
  });

  it("rejects malformed input and shuts down explicitly", async () => {
    const frames: DesktopFrame[] = [];
    const sidecar = makeDesktopSidecar(new FakeDesktopTransport(), (frame) => frames.push(frame));
    await sidecar.start();

    expect(await sidecar.handleLine('{"version":1,"type":"select","sessionId":"bad"}')).toBe(true);
    expect(frames.at(-1)).toMatchObject({ type: "error", code: "invalid_command" });
    expect(await sidecar.handleLine('{"version":1,"type":"shutdown"}')).toBe(false);
    expect(frames.at(-1)).toEqual({ version: 1, type: "stopped" });
  });
});
