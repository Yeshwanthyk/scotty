import { getSandbox } from "@cloudflare/sandbox";
import { Option, Schema } from "effect";
import {
  PI_CONSOLE_MAX_RESPONSE_BYTES,
  PI_CONSOLE_MAX_STRING_BYTES,
} from "../../protocol/pi-console";
import type { Bindings } from "../../worker/src/shared/bindings";
import { readBoundedUtf8Body } from "../../worker/src/shared/bounded-http";
import { decodeJsonValue } from "../../worker/src/shared/json";
import { ContainerProxy } from "../../worker/src/egress/session";
import { SESSION_KV_PREFIX, type SessionRecord } from "../../worker/src/session/contracts";
import { denyOutbound, makeOutboundByHost } from "../../worker/src/egress/worker";
import app from "../../worker/src/index";
import { SESSION_SCHEDULE_CALLBACKS } from "../../worker/src/session/lifecycle";
import { Sandbox as ProductionSandbox } from "../../worker/src/session/object";
import { shellQuote } from "../../worker/src/sandbox/runtime";
import { ScottyAuthRegistry } from "../../worker/src/auth/object";
import { ScottyRunnerRegistry } from "../../worker/src/runner/registry-object";
import { ScottyCredentialRegistry } from "../../worker/src/credentials/object";
import { ScottySandboxConfig } from "../../worker/src/sandbox/config-object";

const RECORD_KEY = "scotty:session";
const CREATE_IDEMPOTENCY_KEY = "scotty:create-idempotency";
const SESSION_ID_PATTERN = /^[0-9a-f]{12}$/u;
const CANARY_STAGE_PATTERN = /^scotty-e2e-[a-f0-9]{32}$/u;
const CANARY_REQUEST_MAX_BYTES = 32 * 1024;

interface CanaryBindings extends Omit<Bindings, "SANDBOX"> {
  readonly SANDBOX: DurableObjectNamespace<ScottySandbox>;
  readonly SCOTTY_E2E_CANARY_STAGE: string;
}

const CanarySessionIdSchema = Schema.String.check(Schema.isPattern(SESSION_ID_PATTERN));
const CanarySteerMessageSchema = Schema.String.check(
  Schema.makeFilter(
    (message) =>
      message.trim().length > 0 &&
      !message.trimStart().startsWith("/") &&
      new TextEncoder().encode(message).byteLength <= PI_CONSOLE_MAX_STRING_BYTES,
    { expected: "a bounded non-command steering message" },
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
  readonly authorityStatus: string | null;
  readonly backups: ReadonlyArray<string>;
  readonly createIdempotency: boolean;
  readonly credentials: boolean;
  readonly githubCredentialCurrent: boolean;
  readonly incarnation: string;
  readonly kv: boolean;
  readonly runtime: boolean;
  readonly schedules: ReadonlyArray<string>;
  readonly registry: ReadonlyArray<{
    readonly name: string;
    readonly kind: string;
    readonly scope: string;
  }>;
}

const jsonError = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
async function readBoundedJson(request: Request): Promise<unknown | undefined> {
  const text = await readBoundedUtf8Body(request, CANARY_REQUEST_MAX_BYTES);
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
    const record = await this.ctx.storage.get<SessionRecord>(RECORD_KEY);
    if (
      record === undefined ||
      record.id !== command.sourceId ||
      record.status !== "warm" ||
      record.operation !== null ||
      record.provider !== "cloudflare" ||
      record.execution.provider !== "cloudflare"
    )
      return jsonError(409, "source session is not an authoritative warm container");

    const invocation =
      command.action === "inspect"
        ? `/usr/local/bin/scotty inspect ${command.targetId} --json`
        : `/usr/local/bin/scotty steer ${command.targetId} ${shellQuote(command.message)} --json`;
    const executed = await this.exec(invocation, {
      env: { SCOTTY_SESSION_ID: record.id },
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
    const [record, createIdempotency, alarm, schedules, state, registryResult] = await Promise.all([
      this.ctx.storage.get<SessionRecord>(RECORD_KEY),
      this.ctx.storage.get(CREATE_IDEMPOTENCY_KEY),
      this.ctx.storage.getAlarm(),
      Promise.all(
        SESSION_SCHEDULE_CALLBACKS.map(async (callback) => ({
          callback,
          count: (await this.listSchedules(callback)).length,
        })),
      ),
      this.getState(),
      this.env.CREDENTIALS?.getByName("account").list(),
    ]);
    const credentialGrant = record?.credentialGrant;
    const backupPage = await this.env.BACKUP_BUCKET.list();
    const projection = record
      ? await this.env.SESSIONS.get(`${SESSION_KV_PREFIX}${record.id}`)
      : null;
    const activeSchedules = schedules
      .filter(({ count }) => count > 0)
      .map(({ callback }) => callback);
    const runtime = state.status !== "stopped" && state.status !== "stopped_with_code";
    return {
      activeLease: record?.operation != null,
      alarm: alarm !== null,
      authorityStatus: record?.status ?? null,
      backups: backupPage.objects.map(({ key }) => key).sort(),
      createIdempotency: createIdempotency !== undefined,
      credentials: credentialGrant !== undefined,
      githubCredentialCurrent:
        credentialGrant?.grants.some((grant) =>
          grant.handleSlots.some(
            ({ provider, slot }) => provider === "github" && slot === "git-https",
          ),
        ) ?? false,
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
    const route = /^\/__e2e\/(probe|reconstruct|peer)\/([^/]+)$/u.exec(url.pathname);
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
