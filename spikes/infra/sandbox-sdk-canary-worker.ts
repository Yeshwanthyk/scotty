import { ContainerProxy, getSandbox } from "@cloudflare/sandbox";
import { Sandbox } from "../../worker/src/session.ts";

const markerKey = "m01c:reconstruction-marker";
const lifecycleKey = "m01c:lifecycle";
const root = "/tmp/m01c-canary";
const sessionId = "m01c-named-session";

interface CanaryBindings {
  readonly SANDBOX: DurableObjectNamespace<ScottySandbox>;
  readonly SESSIONS: KVNamespace;
  readonly BACKUP_BUCKET: R2Bucket;
  readonly ASSETS: Fetcher;
  readonly SANDBOX_TRANSPORT: "rpc";
  readonly BACKUP_BUCKET_NAME: string;
  readonly M01C_CANARY_STAGE: string;
}

export class ScottySandbox extends Sandbox {
  readonly m01cIncarnation = crypto.randomUUID();

  override async onStart(): Promise<void> {
    await super.onStart();
    await this.recordLifecycle("starts");
  }

  override async onStop(): Promise<void> {
    await this.recordLifecycle("stops");
    await super.onStop();
  }

  override async onActivityExpired(): Promise<void> {
    await this.recordLifecycle("activityExpirations");
    await super.onActivityExpired();
    await this.stop();
  }

  async m01cWriteMarker(value: string): Promise<void> {
    await this.ctx.storage.put(markerKey, value);
  }

  async m01cReadMarker(): Promise<string | undefined> {
    return this.ctx.storage.get<string>(markerKey);
  }

  async m01cLifecycle(): Promise<Record<string, number>> {
    return (await this.ctx.storage.get<Record<string, number>>(lifecycleKey)) ?? {};
  }

  m01cAbortHost(): void {
    this.ctx.abort("M01C requested host reconstruction");
  }

  private async recordLifecycle(event: string): Promise<void> {
    const lifecycle = await this.m01cLifecycle();
    lifecycle[event] = (lifecycle[event] ?? 0) + 1;
    await this.ctx.storage.put(lifecycleKey, lifecycle);
  }
}

export { ContainerProxy };

export default {
  async fetch(request: Request, env: CanaryBindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, canary: "m01c" });
    const match = /^\/m01c\/(core|backup|stop|state|reconstruct|pty)$/u.exec(url.pathname);
    if (match === null || !match[1]) return new Response("Not found", { status: 404 });
    const sandboxId = `canary-${env.M01C_CANARY_STAGE}`;
    const sandbox = getSandbox<ScottySandbox>(env.SANDBOX, sandboxId, {
      sleepAfter: "10m",
      transport: "rpc",
      enableDefaultSession: false,
      normalizeId: true,
    });

    if (match[1] === "pty") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      const session = await sandbox.getSession(sessionId);
      return session.terminal(request, { cols: 80, rows: 24, shell: "/bin/cat" });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (match[1] === "state") {
      return Response.json({
        marker: await sandbox.m01cReadMarker(),
        lifecycle: await sandbox.m01cLifecycle(),
        incarnation: sandbox.m01cIncarnation,
      });
    }
    if (match[1] === "reconstruct") {
      sandbox.m01cAbortHost();
      return new Response(null, { status: 204 });
    }
    if (match[1] === "stop") {
      await sandbox.stop();
      return Response.json({ stopped: true });
    }
    if (match[1] === "backup") {
      const backup = await sandbox.createBackup({
        dir: root,
        name: `m01c-${env.M01C_CANARY_STAGE}`,
        ttl: 86_400,
        localBucket: true,
        compression: { format: "zstd" },
      });
      await sandbox.writeFile(`${root}/backup.txt`, "changed-after-backup");
      await sandbox.restoreBackup(backup);
      return Response.json({
        backupId: backup.id,
        restored: (await sandbox.readFile(`${root}/backup.txt`)).content === "before-backup",
      });
    }

    await sandbox.exec(`mkdir -p ${root}`);
    const command = await sandbox.exec("printf m01c-command");
    await sandbox.writeFile(`${root}/file.txt`, "m01c-file");
    await sandbox.renameFile(`${root}/file.txt`, `${root}/renamed.txt`);
    const file = await sandbox.readFile(`${root}/renamed.txt`);
    await sandbox.deleteFile(`${root}/renamed.txt`);
    const fileDeleted = !(await sandbox.exists(`${root}/renamed.txt`)).exists;
    await sandbox.deleteSession(sessionId).catch(() => undefined);
    const session = await sandbox.createSession({
      id: sessionId,
      cwd: root,
      env: { M01C_SESSION_VALUE: "initial" },
    });
    await session.setEnvVars({ M01C_SESSION_VALUE: "synthetic" });
    const namedSession = await session.exec('printf "%s:%s" "$PWD" "$M01C_SESSION_VALUE"');
    const marker = `marker-${env.M01C_CANARY_STAGE}`;
    await sandbox.m01cWriteMarker(marker);
    await sandbox.writeFile(`${root}/backup.txt`, "before-backup");
    const allowed = await sandbox.exec(
      "curl --silent --show-error --output /dev/null --write-out '%{http_code}' https://registry.npmjs.org/",
      { timeout: 30_000 },
    );
    const denied = await sandbox.exec(
      "curl --silent --show-error --output /dev/null --write-out '%{http_code}' https://example.com/",
      { timeout: 30_000 },
    );
    return Response.json({
      command: command.stdout,
      file: file.content,
      fileDeleted,
      namedSession: namedSession.stdout,
      marker: await sandbox.m01cReadMarker(),
      lifecycle: await sandbox.m01cLifecycle(),
      allowedStatus: allowed.stdout,
      deniedStatus: denied.stdout,
    });
  },
};
