import { getSandbox } from "@cloudflare/sandbox";
import { Option, Schema } from "effect";
import { supportedPiProvider } from "../../protocol/pi-auth";
import {
  PI_CONSOLE_MAX_RESPONSE_BYTES,
  PI_CONSOLE_MAX_STRING_BYTES,
} from "../../protocol/pi-console";
import type { Bindings } from "../../worker/src/bindings";
import { readBoundedUtf8Body } from "../../worker/src/bounded-http";
import { ContainerProxy } from "../../worker/src/container-session-egress";
import {
  decodeJsonValue,
  SESSION_KV_PREFIX,
  type SessionRecord,
  type StoredCredential,
} from "../../worker/src/contracts";
import { denyOutbound, makeOutboundByHost } from "../../worker/src/egress";
import app from "../../worker/src/index";
import { runKitesurfCanary } from "../../worker/src/kitesurf-launch";
import { SESSION_SCHEDULE_CALLBACKS } from "../../worker/src/session-lifecycle";
import { Sandbox } from "../../worker/src/session";
import { shellQuote } from "../../worker/src/sandbox-runtime";
import { ScottyAuthRegistry } from "../../worker/src/auth-object";
import { ScottyRunnerRegistry } from "../../worker/src/runner-registry-object";

const RECORD_KEY = "scotty:session";
const CREDENTIAL_KEY = "scotty:credential";
const CREATE_IDEMPOTENCY_KEY = "scotty:create-idempotency";
const SESSION_ID_PATTERN = /^[0-9a-f]{12}$/u;
const CANARY_STAGE_PATTERN = /^scotty-e2e-[a-f0-9]{32}$/u;
const CANARY_REQUEST_MAX_BYTES = 32 * 1024;

interface CanaryBindings extends Omit<Bindings, "SANDBOX"> {
  readonly SANDBOX: DurableObjectNamespace<ScottySandbox>;
  readonly SCOTTY_E2E_CANARY_STAGE: string;
}

interface CanarySecurityProbe {
  readonly defaultDeny: boolean;
  readonly kvNonSecret: boolean;
  readonly sentinelsOnly: boolean;
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
  readonly security: CanarySecurityProbe | null;
}

const jsonError = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

async function readBoundedJson(request: Request): Promise<unknown | undefined> {
  const text = await readBoundedUtf8Body(request, CANARY_REQUEST_MAX_BYTES);
  if (text === undefined) return undefined;
  return Option.getOrUndefined(decodeJsonValue(text));
}

export class ScottySandbox extends Sandbox {
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
    const [record, credential, createIdempotency, alarm, schedules, state] = await Promise.all([
      this.ctx.storage.get<SessionRecord>(RECORD_KEY),
      this.ctx.storage.get<StoredCredential>(CREDENTIAL_KEY),
      this.ctx.storage.get(CREATE_IDEMPOTENCY_KEY),
      this.ctx.storage.getAlarm(),
      Promise.all(
        SESSION_SCHEDULE_CALLBACKS.map(async (callback) => ({
          callback,
          count: (await this.listSchedules(callback)).length,
        })),
      ),
      this.getState(),
    ]);
    const backupPage = await this.env.BACKUP_BUCKET.list();
    const projection = record
      ? await this.env.SESSIONS.get(`${SESSION_KV_PREFIX}${record.id}`)
      : null;
    const activeSchedules = schedules
      .filter(({ count }) => count > 0)
      .map(({ callback }) => callback);
    const runtime = state.status !== "stopped" && state.status !== "stopped_with_code";
    const security =
      credential && record?.status === "warm"
        ? await this.e2eSecurityProbe(record, credential, projection)
        : null;

    return {
      activeLease: record?.operation != null,
      alarm: alarm !== null,
      authorityStatus: record?.status ?? null,
      backups: backupPage.objects.map(({ key }) => key).sort(),
      createIdempotency: createIdempotency !== undefined,
      credentials: credential !== undefined,
      githubCredentialCurrent: credential?.githubToken === this.env.GH_TOKEN,
      incarnation: this.e2eIncarnation,
      kv: projection !== null,
      runtime,
      schedules: activeSchedules,
      security,
    };
  }

  e2eAbortHost(): Promise<void> {
    this.ctx.abort("Full-stack E2E requested host reconstruction");
    return Promise.resolve();
  }

  private async e2eSecurityProbe(
    record: SessionRecord,
    credential: StoredCredential,
    projection: string | null,
  ): Promise<CanarySecurityProbe> {
    const root = `/workspace/${record.id}`;
    const surface = await this.exec(
      `printf '%s\\n' "$GH_TOKEN" "$GITHUB_SENTINEL"; cat ${root}/.pi-agent/auth.json; git -C ${root} config --local --list; curl --silent --output /dev/null --write-out '%{http_code}' https://example.com/`,
      { timeout: 30_000 },
    );
    const serializedSurface = `${surface.stdout}\n${surface.stderr}`;
    const realSecrets = [
      credential.githubToken,
      ...Object.values(credential.providers).flatMap((provider) =>
        provider.credential.type === "api_key"
          ? [provider.credential.key]
          : [provider.credential.access, provider.credential.refresh],
      ),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    const containsRealSecret = (value: string): boolean =>
      realSecrets.some((secret) => value.includes(secret));

    return {
      defaultDeny: /(?:403|520)\s*$/u.test(surface.stdout.trim()),
      kvNonSecret: projection !== null && !containsRealSecret(projection),
      sentinelsOnly:
        Object.entries(credential.providers)
          .filter(([providerId]) => supportedPiProvider(providerId))
          .every(([, provider]) => serializedSurface.includes(provider.sentinel)) &&
        serializedSurface.includes(credential.githubSentinel) &&
        !containsRealSecret(serializedSurface),
    };
  }
}

ScottySandbox.outboundByHost = makeOutboundByHost(fetch);
ScottySandbox.outbound = denyOutbound;

export { ContainerProxy, ScottyAuthRegistry, ScottyRunnerRegistry };

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
      const github = await fetch("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${env.GH_TOKEN}`,
          "user-agent": "Scotty deployed E2E",
        },
      });
      return Response.json({
        githubStatus: github.status,
        githubTokenBytes: new TextEncoder().encode(env.GH_TOKEN).byteLength,
      });
    }
    if (url.pathname === "/__e2e/kitesurf") {
      if (!canaryAuthorized(request, env)) return jsonError(401, "unauthorized");
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return Response.json(await runKitesurfCanary(env.BROWSER));
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
