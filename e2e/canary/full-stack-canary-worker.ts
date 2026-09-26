import { getSandbox } from "@cloudflare/sandbox";
import { Effect, Option, Schema } from "effect";
import { PI_CONSOLE_MAX_RESPONSE_BYTES } from "../../protocol/agents/pi/pi-console";
import type { Bindings } from "../../worker/src/shared/bindings";
import { readBoundedUtf8Body } from "../../worker/src/shared/bounded-http";
import { runtimeCliExecutable } from "../../worker/src/runtime-cli/paths";
import { decodeJsonValue } from "../../worker/src/shared/json";
import { ContainerProxy } from "../../worker/src/egress/session";
import { SESSION_KV_PREFIX } from "../../worker/src/session/contracts";
import {
  AuthorityStateSchema,
  publicRecovery,
  StableStateSchema,
  type SessionAuthority,
} from "../../worker/src/session-actor/reducer/authority";
import { publicView, type PublicStatus } from "../../worker/src/session-actor/public-view";
import type { LifecycleJournalEvent } from "../../worker/src/session-actor/journal";
import type { SessionActorMetadata } from "../../worker/src/session-actor/metadata";
import { makeActorStore } from "../../worker/src/session-actor/store";
import { makeSessionActorMetadataStore } from "../../worker/src/session-actor/metadata-store";
import {
  durableObjectSessionActorMetadataStorage,
  durableObjectSessionActorStorage,
} from "../../worker/src/session/store";
import { denyOutbound, makeOutboundByHost } from "../../worker/src/egress/worker";
import app from "../../worker/src/index";
import { SESSION_SCHEDULE_CALLBACKS } from "../../worker/src/session/lifecycle";
import { Sandbox as ProductionSandbox } from "../../worker/src/session/object";
import { shellQuote } from "../../worker/src/sandbox/runtime";
import { ScottyAuthRegistry } from "../../worker/src/auth/object";
import { ScottyRunnerRegistry } from "../../worker/src/runner/registry-object";
import {
  CREDENTIAL_REGISTRY_OBJECT_NAME,
  ScottyCredentialRegistry,
} from "../../worker/src/credentials/object";
import { ScottySandboxConfig } from "../../worker/src/sandbox/config-object";

const FILL_DISK_COMMAND = [
  "set -eu",
  "mkdir -p /var/backups",
  "avail=$(df --output=avail -B1 /var/backups | tail -n 1 | tr -d ' ')",
  "fallocate -l $((avail - 1048576)) /var/backups/scotty-e2e-fill",
  "df --output=avail -B1 /var/backups | tail -n 1 | tr -d ' '",
].join("\n");
const SESSION_ID_PATTERN = /^[0-9a-f]{12}$/u;
const CANARY_STAGE_PATTERN = /^scotty-e2e-[a-f0-9]{32}$/u;

interface CanaryBindings extends Omit<Bindings, "SANDBOX"> {
  readonly SANDBOX: DurableObjectNamespace<ScottySandbox>;
  readonly SCOTTY_E2E_CANARY_STAGE: string;
}

const CanarySessionIdSchema = Schema.String.check(Schema.isPattern(SESSION_ID_PATTERN));
const CanarySteerMessageSchema = Schema.String.check(
  Schema.makeFilter(
    (message) => message.trim().length > 0 && !message.trimStart().startsWith("/"),
    { expected: "a non-empty non-command steering message" },
  ),
);
const CanaryPeerRouteInputSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("inspect"),
    stage: Schema.String,
    targetId: CanarySessionIdSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("steer"),
    message: CanarySteerMessageSchema,
    stage: Schema.String,
    targetId: CanarySessionIdSchema,
  }),
]);
const CanaryPeerCommandSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("inspect"),
    sourceId: CanarySessionIdSchema,
    stage: Schema.String,
    targetId: CanarySessionIdSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("steer"),
    message: CanarySteerMessageSchema,
    sourceId: CanarySessionIdSchema,
    stage: Schema.String,
    targetId: CanarySessionIdSchema,
  }),
]);
type CanaryPeerCommand = typeof CanaryPeerCommandSchema.Type;
const decodePeerRouteInput = Schema.decodeUnknownOption(CanaryPeerRouteInputSchema, {
  onExcessProperty: "error",
});
const decodePeerCommandInput = Schema.decodeUnknownOption(CanaryPeerCommandSchema, {
  onExcessProperty: "error",
});
interface CanaryOrphanProbe {
  readonly activeLease: boolean;
  readonly alarm: boolean;
  readonly authorityStatus: PublicStatus | null;
  readonly backups: ReadonlyArray<string>;
  readonly createIdempotency: boolean;
  readonly credentials: boolean;
  readonly githubCredentialCurrent: boolean;
  readonly incarnation: string;
  readonly kv: boolean;
  readonly failureCode: string | null;
  readonly lastTransitionKind: LifecycleJournalEvent["transitionKind"];
  readonly phase: string | null;
  readonly recovery: "resume" | "create" | "terminal" | null;
  readonly runtime: boolean;
  readonly schedules: ReadonlyArray<string>;
  readonly registry: ReadonlyArray<{
    readonly name: string;
    readonly kind: string;
    readonly scope: string;
  }>;
}

const actorProbeFields = (
  authority: SessionAuthority | undefined,
  journalTail: LifecycleJournalEvent | undefined,
  metadata: SessionActorMetadata | undefined,
): Pick<
  CanaryOrphanProbe,
  | "activeLease"
  | "authorityStatus"
  | "createIdempotency"
  | "credentials"
  | "failureCode"
  | "githubCredentialCurrent"
  | "lastTransitionKind"
  | "phase"
  | "recovery"
> => {
  const transitioning =
    authority !== undefined && AuthorityStateSchema.guards.Transitioning(authority.state)
      ? authority.state.transition
      : null;
  const failed =
    authority !== undefined &&
    AuthorityStateSchema.guards.Stable(authority.state) &&
    StableStateSchema.guards.Failed(authority.state.stable)
      ? authority.state.stable
      : null;
  const credentialGrants = metadata?.createObservations.credentialGrants;
  return {
    activeLease: transitioning !== null,
    authorityStatus: publicView(authority)?.status ?? null,
    createIdempotency: metadata?.createIdempotency != null,
    credentials: credentialGrants !== null && credentialGrants !== undefined,
    failureCode: failed === null ? null : failed.code,
    githubCredentialCurrent:
      credentialGrants?.grants.some((grant) =>
        grant.handleSlots.some(
          ({ provider, slot }) => provider === "github" && slot === "git-https",
        ),
      ) ?? false,
    lastTransitionKind: journalTail === undefined ? null : journalTail.transitionKind,
    phase: transitioning?.phase ?? null,
    recovery: failed === null ? null : publicRecovery(failed.recovery),
  };
};

const jsonError = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
async function readBoundedJson(request: Request): Promise<unknown | undefined> {
  const text = await readBoundedUtf8Body(request);
  if (text === undefined) return undefined;
  return Option.getOrUndefined(decodeJsonValue(text));
}

export const ScottySandbox = class Sandbox extends ProductionSandbox {
  private readonly e2eIncarnation = crypto.randomUUID();

  async e2ePeerCommand(input: unknown): Promise<Response> {
    const decoded = decodePeerCommandInput(input);
    if (Option.isNone(decoded)) return jsonError(400, "invalid peer command");
    const command: CanaryPeerCommand = decoded.value;
    if (!CANARY_STAGE_PATTERN.test(command.stage) || command.sourceId === command.targetId)
      return jsonError(400, "invalid peer command");
    const { authority } = await Effect.runPromise(
      makeActorStore(durableObjectSessionActorStorage(this.ctx.storage)).read,
    );
    if (
      authority === undefined ||
      authority.session.id !== command.sourceId ||
      authority.session.execution.provider !== "cloudflare" ||
      !AuthorityStateSchema.guards.Stable(authority.state) ||
      !StableStateSchema.guards.Warm(authority.state.stable)
    )
      return jsonError(409, "source session is not an authoritative warm container");

    const executable = shellQuote(runtimeCliExecutable(authority.session.id));
    const invocation =
      command.action === "inspect"
        ? `${executable} inspect ${command.targetId} --json`
        : `${executable} steer ${command.targetId} ${shellQuote(command.message)} --json`;
    const executed = await this.exec(invocation, {
      env: { SCOTTY_SESSION_ID: authority.session.id },
      timeout: 60_000,
    })
      .then((result) => ({ result }))
      .catch(() => undefined);
    if (executed === undefined) return jsonError(502, "source container command failed");
    const { exitCode, stderr, stdout } = executed.result;
    if (
      utf8Bytes(stdout) > PI_CONSOLE_MAX_RESPONSE_BYTES ||
      utf8Bytes(stderr) > PI_CONSOLE_MAX_RESPONSE_BYTES
    )
      return jsonError(502, "source container command output exceeded the canary limit");
    return Response.json(
      { exitCode, stderr, stdout },
      { headers: { "cache-control": "no-store" } },
    );
  }

  async e2eProbe(): Promise<CanaryOrphanProbe> {
    const [snapshot, alarm, schedules, state, registryResult] = await Promise.all([
      Effect.runPromise(makeActorStore(durableObjectSessionActorStorage(this.ctx.storage)).read),
      this.ctx.storage.getAlarm(),
      Promise.all(
        SESSION_SCHEDULE_CALLBACKS.map(async (callback) => ({
          callback,
          count: (await this.listSchedules(callback)).length,
        })),
      ),
      this.getState(),
      this.env.CREDENTIALS?.getByName(CREDENTIAL_REGISTRY_OBJECT_NAME).list(),
    ]);
    const authority = snapshot.authority;
    const metadata =
      authority === undefined
        ? undefined
        : await Effect.runPromise(
            makeSessionActorMetadataStore(
              durableObjectSessionActorMetadataStorage(this.ctx.storage),
            ).read(authority),
          );
    const backupPage = await this.env.BACKUP_BUCKET.list();
    const projection = authority
      ? await this.env.SESSIONS.get(`${SESSION_KV_PREFIX}${authority.session.id}`)
      : null;
    const activeSchedules = schedules
      .filter(({ count }) => count > 0)
      .map(({ callback }) => callback);
    const runtime = state.status !== "stopped" && state.status !== "stopped_with_code";
    return {
      alarm: alarm !== null,
      backups: backupPage.objects.map(({ key }) => key).sort(),
      ...actorProbeFields(authority, snapshot.journalTail, metadata),
      incarnation: this.e2eIncarnation,
      kv: projection !== null,
      runtime,
      schedules: activeSchedules,
      registry:
        registryResult?.ok === true
          ? registryResult.value.map(({ name, kind, scope }) => ({ name, kind, scope }))
          : [],
    };
  }

  // Leaves the SDK backup filesystem nearly full so the next Sleep backup fails in the provider.
  async e2eFillDisk(): Promise<Response> {
    const executed = await this.exec(FILL_DISK_COMMAND, { timeout: 60_000 })
      .then((result) => ({ result }))
      .catch(() => undefined);
    if (executed === undefined || executed.result.exitCode !== 0)
      return jsonError(502, "disk fill command failed");
    const availableBytes = Number(executed.result.stdout.trim());
    if (!Number.isSafeInteger(availableBytes)) return jsonError(502, "disk fill output invalid");
    return Response.json({ availableBytes }, { headers: { "cache-control": "no-store" } });
  }

  e2eAbortHost(): Promise<void> {
    this.ctx.abort("Full-stack E2E requested host reconstruction");
    return Promise.resolve();
  }
};

export type ScottySandbox = InstanceType<typeof ScottySandbox>;

ScottySandbox.outboundByHost = makeOutboundByHost(fetch);
ScottySandbox.outbound = denyOutbound;

export {
  ContainerProxy,
  ScottyAuthRegistry,
  ScottyCredentialRegistry,
  ScottyRunnerRegistry,
  ScottySandboxConfig,
};

const canaryAuthorized = (request: Request, env: CanaryBindings): boolean =>
  CANARY_STAGE_PATTERN.test(env.SCOTTY_E2E_CANARY_STAGE) &&
  request.headers.get("x-scotty-e2e-stage") === env.SCOTTY_E2E_CANARY_STAGE &&
  request.headers.get("authorization") === `Bearer ${env.SCOTTY_TOKEN}`;

export default {
  async fetch(request: Request, env: CanaryBindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__e2e/config") {
      if (!canaryAuthorized(request, env)) return jsonError(401, "unauthorized");
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return Response.json({
        githubStatus: null,
        githubTokenBytes: 0,
      });
    }
    const route = /^\/__e2e\/(probe|reconstruct|peer|fill-disk)\/([^/]+)$/u.exec(url.pathname);
    if (route === null) return app.fetch(request, env, ctx);
    if (!canaryAuthorized(request, env)) return jsonError(401, "unauthorized");
    const id = route[2];
    if (!id || !SESSION_ID_PATTERN.test(id)) return jsonError(400, "invalid session id");
    const sandbox = getSandbox<ScottySandbox>(env.SANDBOX, id, {
      sleepAfter: "60m",
      transport: "rpc",
      enableDefaultSession: false,
      normalizeId: true,
    });
    if (route[1] === "reconstruct") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      await sandbox.e2eAbortHost();
      return new Response(null, { status: 204 });
    }
    if (route[1] === "fill-disk") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return sandbox.e2eFillDisk();
    }
    if (route[1] === "peer") {
      if (
        request.method !== "POST" ||
        request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/json"
      )
        return new Response("Method not allowed", { status: 405 });
      const body = await readBoundedJson(request);
      const decoded = decodePeerRouteInput(body);
      if (Option.isNone(decoded) || decoded.value.stage !== env.SCOTTY_E2E_CANARY_STAGE)
        return jsonError(400, "invalid peer command");
      return sandbox.e2ePeerCommand({
        ...decoded.value,
        sourceId: id,
        stage: env.SCOTTY_E2E_CANARY_STAGE,
      });
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return Response.json(await sandbox.e2eProbe());
  },
};
