import { ContainerProxy, getSandbox } from "@cloudflare/sandbox";
import type { Bindings } from "../../worker/src/bindings";
import {
  SESSION_KV_PREFIX,
  type SessionRecord,
  type StoredCredential,
} from "../../worker/src/contracts";
import { denyOutbound, makeOutboundByHost } from "../../worker/src/egress";
import app from "../../worker/src/index";
import { SESSION_SCHEDULE_CALLBACKS } from "../../worker/src/session-lifecycle";
import { Sandbox } from "../../worker/src/session";
import { ScottyAuthRegistry } from "../../worker/src/auth-object";
import { ScottyRunnerRegistry } from "../../worker/src/runner-registry-object";

const RECORD_KEY = "scotty:session";
const CREDENTIAL_KEY = "scotty:credential";
const CREATE_IDEMPOTENCY_KEY = "scotty:create-idempotency";
const SESSION_ID_PATTERN = /^[0-9a-f]{12}$/u;

interface CanaryBindings extends Omit<Bindings, "SANDBOX"> {
  readonly SANDBOX: DurableObjectNamespace<ScottySandbox>;
  readonly SCOTTY_E2E_CANARY_STAGE: string;
}

interface CanarySecurityProbe {
  readonly defaultDeny: boolean;
  readonly kvNonSecret: boolean;
  readonly sentinelsOnly: boolean;
}

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

export class ScottySandbox extends Sandbox {
  private readonly e2eIncarnation = crypto.randomUUID();

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
        Object.values(credential.providers).every((provider) =>
          serializedSurface.includes(provider.sentinel),
        ) &&
        serializedSurface.includes(credential.githubSentinel) &&
        !containsRealSecret(serializedSurface),
    };
  }
}

ScottySandbox.outboundByHost = makeOutboundByHost(fetch);
ScottySandbox.outbound = denyOutbound;

export { ContainerProxy, ScottyAuthRegistry, ScottyRunnerRegistry };

export default {
  async fetch(request: Request, env: CanaryBindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__e2e/config") {
      if (
        request.headers.get("authorization") !== `Bearer ${env.SCOTTY_TOKEN}` ||
        env.SCOTTY_E2E_CANARY_STAGE.length === 0
      ) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
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
    const probe = /^\/__e2e\/(probe|reconstruct)\/([^/]+)$/u.exec(url.pathname);
    if (probe === null) return app.fetch(request, env, ctx);
    if (
      request.headers.get("authorization") !== `Bearer ${env.SCOTTY_TOKEN}` ||
      env.SCOTTY_E2E_CANARY_STAGE.length === 0
    ) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const id = probe[2];
    if (!id || !SESSION_ID_PATTERN.test(id)) {
      return Response.json({ error: "invalid session id" }, { status: 400 });
    }
    const sandbox = getSandbox<ScottySandbox>(env.SANDBOX, id, {
      sleepAfter: "60m",
      transport: "rpc",
      enableDefaultSession: false,
      normalizeId: true,
    });
    if (probe[1] === "reconstruct") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      await sandbox.e2eAbortHost();
      return new Response(null, { status: 204 });
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return Response.json(await sandbox.e2eProbe());
  },
};
