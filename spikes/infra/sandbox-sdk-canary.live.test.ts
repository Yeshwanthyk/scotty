import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assertM01CCanaryConfig, m01cCanaryNames } from "./sandbox-sdk-canary.ts";

const stage = process.env.ALCHEMY_STAGE ?? "";
const baseUrl = process.env.SCOTTY_M01C_CANARY_URL ?? "";
const liveApproval = process.env.SCOTTY_M01C_RUN_LIVE;
const expectedWorkerName = m01cCanaryNames(stage).worker;
const approved = (() => {
  try {
    assertM01CCanaryConfig({
      stage,
      deployApproval: `deploy:${stage}`,
      cleanupApproval: undefined,
      armCleanup: false,
      telemetryDisabled: true,
      pinnedSafetyExtensionsReady: true,
    });
    return (
      liveApproval === `run:${stage}` &&
      baseUrl.startsWith("https://") &&
      new URL(baseUrl).hostname.startsWith(`${expectedWorkerName}.`)
    );
  } catch {
    return false;
  }
})();

const CoreResponse = Schema.Struct({
  command: Schema.String,
  file: Schema.String,
  fileDeleted: Schema.Boolean,
  namedSession: Schema.String,
  marker: Schema.String,
  lifecycle: Schema.Record(Schema.String, Schema.Number),
  allowedStatus: Schema.String,
  deniedStatus: Schema.String,
});
const StateResponse = Schema.Struct({
  marker: Schema.String,
  lifecycle: Schema.Record(Schema.String, Schema.Number),
  incarnation: Schema.String,
});
const BackupResponse = Schema.Struct({
  backupId: Schema.String,
  restored: Schema.Boolean,
});
const EmptyResponse = Schema.Unknown;
const decodeCoreResponse = Schema.decodeUnknownEffect(CoreResponse);
const decodeStateResponse = Schema.decodeUnknownEffect(StateResponse);
const decodeBackupResponse = Schema.decodeUnknownEffect(BackupResponse);
const decodeEmptyResponse = Schema.decodeUnknownEffect(EmptyResponse);

const ptyRoundTrip = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const websocketUrl = new URL(`${baseUrl}/m01c/pty`);
    websocketUrl.protocol = "wss:";
    const socket = new WebSocket(websocketUrl);
    socket.binaryType = "arraybuffer";
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("M01C PTY did not exchange data"));
    }, 30_000);
    socket.addEventListener("open", () => socket.send(new TextEncoder().encode("m01c-pty")));
    socket.addEventListener("message", (event) => {
      const output =
        event.data instanceof ArrayBuffer
          ? new TextDecoder().decode(event.data)
          : String(event.data);
      if (!output.includes("m01c-pty")) return;
      clearTimeout(timeout);
      socket.close();
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("M01C PTY WebSocket failed"));
    });
  });

const post = <A, E, R>(action: string, decode: (value: unknown) => Effect.Effect<A, E, R>) =>
  Effect.tryPromise({
    try: () =>
      fetch(`${baseUrl}/m01c/${action}`, { method: "POST" }).then(async (response) => {
        if (!response.ok) throw new Error(`M01C ${action} returned HTTP ${response.status}`);
        return response.json();
      }),
    catch: () => new Error(`M01C ${action} request failed`),
  }).pipe(Effect.flatMap(decode));

describe.skipIf(!approved)("M01C explicitly approved deployed assertions", () => {
  it.effect("proves commands, files, named sessions, and outbound interception", () =>
    Effect.gen(function* () {
      const result = yield* post("core", decodeCoreResponse);
      assert.equal(result.command, "m01c-command");
      assert.equal(result.file, "m01c-file");
      assert.equal(result.fileDeleted, true);
      assert.equal(result.namedSession, "/tmp/m01c-canary:synthetic");
      assert.equal(result.marker, `marker-${stage}`);
      assert.match(result.allowedStatus, /^2\d\d$/u);
      assert.equal(result.deniedStatus, "403");
    }),
  );

  it.effect("proves DO storage and lifecycle counters survive reconstruction", () =>
    Effect.gen(function* () {
      yield* post("core", decodeCoreResponse);
      const before = yield* post("state", decodeStateResponse);
      yield* Effect.ignore(post("reconstruct", decodeEmptyResponse));
      const reconstructed = yield* post("state", decodeStateResponse);
      assert.equal(reconstructed.marker, `marker-${stage}`);
      assert.notEqual(reconstructed.incarnation, before.incarnation);
    }),
  );

  it.effect("proves credential-less binding-backed R2 backup and restore", () =>
    Effect.gen(function* () {
      yield* post("core", decodeCoreResponse);
      const result = yield* post("backup", decodeBackupResponse);
      assert.ok(result.backupId.length > 0);
      assert.equal(result.restored, true);
    }),
  );

  it.effect("requires the native PTY WebSocket endpoint", () =>
    Effect.tryPromise({
      try: async () => {
        await ptyRoundTrip();
        await ptyRoundTrip();
      },
      catch: () => new Error("M01C PTY assertion failed"),
    }),
  );
});
