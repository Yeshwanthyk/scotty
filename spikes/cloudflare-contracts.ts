import {
  ContainerProxy,
  Sandbox,
  getSandbox,
  type DirectoryBackup,
  type RestoreBackupResult,
} from "@cloudflare/sandbox";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { Hono } from "hono";

interface ProbeEnv {
  SANDBOX: DurableObjectNamespace<ContractSandbox>;
  BACKUP_BUCKET: R2Bucket;
  PROBE_TOKEN: string;
}

interface ProbeResult {
  containerId: string;
  stored: boolean;
  transport: "rpc";
}

export class ContractSandbox extends Sandbox<ProbeEnv> {
  defaultPort = 3000;
  sleepAfter = "60m";
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = ["contract.invalid"];

  async probeRpc(value: string): Promise<ProbeResult> {
    await this.ctx.storage.put("rpc-probe", value);
    return {
      containerId: this.ctx.id.toString(),
      stored: (await this.ctx.storage.get<string>("rpc-probe")) === value,
      transport: "rpc",
    };
  }

  async probeBackup(): Promise<{
    backup: DirectoryBackup;
    restore: RestoreBackupResult;
  }> {
    const dir = "/workspace/contract-probe";
    await this.mkdir(dir, { recursive: true });
    await this.writeFile(`${dir}/sentinel.txt`, "contract-probe");
    const backup = await this.createBackup({ dir, name: "contract-probe" });
    const restore = await this.restoreBackup(backup);
    return { backup, restore };
  }

  async scheduleHardCap(): Promise<void> {
    await this.schedule(new Date(Date.now() + 60_000), "hardCapProbe", {
      scheduledAt: new Date().toISOString(),
    });
  }

  async hardCapProbe(payload: { scheduledAt: string }): Promise<void> {
    await this.ctx.storage.put("hard-cap-probe", payload);
  }

  override async onActivityExpired(): Promise<void> {
    await this.ctx.storage.put("activity-expired-probe", new Date().toISOString());
    await this.stop();
  }

  static outboundByHost = {
    "contract.invalid": (_request: Request, _env: unknown, context: OutboundHandlerContext) =>
      Response.json({ containerId: context.containerId }),
  };
}

export { ContainerProxy };

const app = new Hono<{ Bindings: ProbeEnv }>();

app.use("*", async (context, next) => {
  const authorization = context.req.header("Authorization");
  const expected = context.env.PROBE_TOKEN;
  if (!expected || authorization !== `Bearer ${expected}`) {
    return context.json({ error: "unauthorized" }, 401);
  }

  await next();
});

function sandboxFor(env: ProbeEnv, id: string): ContractSandbox {
  return getSandbox(env.SANDBOX, id, {
    transport: "rpc",
    sleepAfter: "60m",
    enableDefaultSession: false,
  });
}

app.get("/rpc/:id", async (context) => {
  const result = await sandboxFor(context.env, context.req.param("id")).probeRpc(
    crypto.randomUUID(),
  );
  return context.json(result);
});

app.post("/backup/:id", async (context) => {
  const result = await sandboxFor(context.env, context.req.param("id")).probeBackup();
  return context.json(result);
});

app.post("/schedule/:id", async (context) => {
  await sandboxFor(context.env, context.req.param("id")).scheduleHardCap();
  return context.json({ scheduled: true });
});

app.get("/terminal/:id", async (context) => {
  const sandbox = sandboxFor(context.env, context.req.param("id"));
  const cwd = "/tmp/scotty-contract-terminal";
  await sandbox.mkdir(cwd, { recursive: true });
  await sandbox.exec(
    "install -d -m 700 /root/.local/state/scotty && SHEPPARD_SOCKET=/tmp/scotty-sheppard.sock SHEPPARD_STATE_PATH=/root/.local/state/scotty/sheppard.json sheppard spawn --cwd /tmp/scotty-contract-terminal --title agent --cmd 'exec sh' --json",
  );
  const terminalSession = await sandbox.createSession({
    id: "agent-terminal",
    name: "agent-terminal",
    cwd,
  });
  return terminalSession.terminal(context.req.raw, {
    cols: 80,
    rows: 24,
    shell: "/usr/local/bin/scotty-attach",
  });
});

export default app;
