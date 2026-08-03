import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EMBEDDED_SKILL,
  EXIT,
  main,
  STANDARD_TOOLSET,
  VERSION,
  type CliDependencies,
} from "../scotty";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "scotty-cli-test-"));
  temporaryDirectories.push(path);
  return path;
}

function harness(overrides: Partial<CliDependencies> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let prompts = 0;
  const deps: Partial<CliDependencies> = {
    env: {},
    home: "/tmp/unused-scotty-home",
    cwd: "/tmp/repo",
    stdoutIsTTY: false,
    stdinIsTTY: false,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    prompt: () => {
      prompts++;
      return null;
    },
    openBrowser: async () => {},
    run: async () => ({
      exitCode: 0,
      stdout: "0123456789abcdef0123456789abcdef01234567\n",
      stderr: "",
    }),
    ...overrides,
  };
  return {
    deps,
    stdout,
    stderr,
    prompts: () => prompts,
    json: () => JSON.parse(stdout.join("")),
    error: () => JSON.parse(stderr.join("")),
  };
}

describe("configuration and transport", () => {
  test("flags override env and config; non-TTY output is stable JSON", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      join(home, ".scotty.json"),
      JSON.stringify({ host: "https://config.example", token: "config-token" }),
    );
    let request: Request | undefined;
    const h = harness({
      home,
      env: { SCOTTY_HOST: "https://env.example", SCOTTY_TOKEN: "env-token" },
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          id: "s1",
          title: "Fix build",
          url: "https://flag.example/s/s1?t=server-secret",
          branch: "scotty/s1",
          provider: "cloudflare",
          status: "warm",
        });
      },
    });

    const code = await main(
      [
        "beam",
        "up",
        "fix it",
        "--title",
        "Fix build",
        "--repo",
        "owner/project",
        "--provider",
        "cloudflare",
        "--detach",
        "--host",
        "https://flag.example/",
        "--token",
        "flag-token",
      ],
      h.deps,
    );

    expect(code).toBe(EXIT.OK);
    expect(request?.url).toBe("https://flag.example/api/sessions");
    expect(request?.headers.get("authorization")).toBe("Bearer flag-token");
    expect(await request?.json()).toEqual({
      title: "Fix build",
      prompt: "fix it",
      provider: "cloudflare",
      repo: "owner/project",
    });
    expect(h.json()).toEqual({
      id: "s1",
      title: "Fix build",
      url: "https://flag.example/s/s1",
      branch: "scotty/s1",
      provider: "cloudflare",
      status: "warm",
    });
    expect(h.stdout.join("")).not.toContain("server-secret");
  });

  test("beam up converts the human cap to the Worker contract", async () => {
    let body: unknown;
    const h = harness({
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({
          id: "s1",
          title: "Fix build",
          url: "https://worker.example/s/s1",
          branch: "scotty/s1",
          provider: "cloudflare",
          status: "warm",
        });
      },
    });
    expect(
      await main(
        [
          "beam",
          "up",
          "fix it",
          "--title",
          "Fix build",
          "--repo",
          "owner/project",
          "--provider",
          "cloudflare",
          "--cap",
          "90m",
          "--detach",
          "--host",
          "https://worker.example",
          "--token",
          "secret",
        ],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    expect(body).toEqual({
      title: "Fix build",
      prompt: "fix it",
      provider: "cloudflare",
      repo: "owner/project",
      cap: "90m",
      hardCapSeconds: 5_400,
    });

    const invalid = harness();
    expect(
      await main(
        [
          "beam",
          "up",
          "fix it",
          "--title",
          "Fix build",
          "--repo",
          "owner/project",
          "--provider",
          "cloudflare",
          "--cap",
          "2d",
          "--detach",
          "--host",
          "https://worker.example",
          "--token",
          "secret",
        ],
        invalid.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(invalid.error().error.code).toBe("bad_usage");
  });

  test("beam up reuses a pending idempotency key after an ambiguous network failure", async () => {
    const home = await temporaryDirectory();
    const keys: string[] = [];
    let requests = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      keys.push(request.headers.get("idempotency-key") ?? "");
      requests += 1;
      if (requests === 1) throw new Error("connection dropped after create");
      return Response.json({
        id: "s1",
        title: "Fix build",
        url: "https://worker.example/s/s1",
        branch: "scotty/s1",
        provider: "cloudflare",
        status: "warm",
      });
    };
    const args = [
      "beam",
      "up",
      "fix it",
      "--title",
      "Fix build",
      "--repo",
      "owner/project",
      "--provider",
      "cloudflare",
      "--detach",
      "--host",
      "https://worker.example",
      "--token",
      "secret",
    ];

    expect(await main(args, harness({ home, fetch }).deps)).toBe(EXIT.GENERIC);
    expect(await main(args, harness({ home, fetch }).deps)).toBe(EXIT.OK);
    expect(await main(args, harness({ home, fetch }).deps)).toBe(EXIT.OK);

    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  test("env overrides config and config is the final fallback", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      join(home, ".scotty.json"),
      JSON.stringify({ host: "https://config.example", token: "config-token" }),
    );
    const seen: string[] = [];
    const h = harness({
      home,
      env: { SCOTTY_HOST: "https://env.example", SCOTTY_TOKEN: "env-token" },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seen.push(`${request.url} ${request.headers.get("authorization")}`);
        return Response.json([]);
      },
    });
    expect(await main(["ls"], h.deps)).toBe(EXIT.OK);

    const fallback = harness({
      home,
      env: {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seen.push(`${request.url} ${request.headers.get("authorization")}`);
        return Response.json([]);
      },
    });
    expect(await main(["ls"], fallback.deps)).toBe(EXIT.OK);
    expect(seen).toEqual([
      "https://env.example/api/sessions Bearer env-token",
      "https://config.example/api/sessions Bearer config-token",
    ]);
  });

  test("complete flags bypass a malformed config for stateless agents", async () => {
    const home = await temporaryDirectory();
    await writeFile(join(home, ".scotty.json"), "not-json");
    const h = harness({ home, fetch: async () => Response.json([]) });
    expect(
      await main(["ls", "--host", "https://worker.example", "--token", "secret"], h.deps),
    ).toBe(EXIT.OK);
    expect(h.json()).toEqual([]);
  });

  test("config fields decode independently and unknown fields are ignored", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      join(home, ".scotty.json"),
      JSON.stringify({
        host: { wrong: true },
        token: "config-token",
        credentialBundle: "must-not-leak",
      }),
    );
    let request: Request | undefined;
    const h = harness({
      home,
      env: { SCOTTY_HOST: "https://env.example" },
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json([]);
      },
    });

    expect(await main(["ls"], h.deps)).toBe(EXIT.OK);
    expect(request?.url).toBe("https://env.example/api/sessions");
    expect(request?.headers.get("authorization")).toBe("Bearer config-token");
    expect(h.stdout.join("")).not.toContain("must-not-leak");
  });

  test("init is create-only and rejects direct connection credentials", async () => {
    const home = await temporaryDirectory();
    const h = harness({ home });
    const code = await main(
      ["init", "--host", "https://worker.example/", "--token", "top-secret"],
      h.deps,
    );

    expect(code).toBe(EXIT.USAGE);
    expect(h.error().error.message).toBe("init does not accept --host or --token");
    expect(h.stdout.join("")).not.toContain("top-secret");
    expect(h.prompts()).toBe(0);
  });

  test("init creates a required named installation and stores a portable pointer", async () => {
    const home = await temporaryDirectory();
    let request: Parameters<NonNullable<CliDependencies["createInstallation"]>>[0] | undefined;
    const h = harness({
      home,
      createInstallation: async (input) => {
        request = input;
        return {
          installationName: input.installationName,
          profile: input.profile,
          stackName: "Scotty-home",
          stage: "production",
          accountId: "0123456789abcdef0123456789abcdef",
          workerName: "scotty-home-worker",
          runnerWorkerName: "scotty-home-runner",
          containerName: "scotty-home-sandbox",
          kvTitle: "scotty-home-sessions",
          backupBucketName: "scotty-home-backups",
          host: "https://scotty-home-worker.example.workers.dev/",
        };
      },
    });

    expect(await main(["init", "--name", "home", "--profile", "personal"], h.deps)).toBe(EXIT.OK);
    expect(request).toMatchObject({
      installationName: "home",
      profile: "personal",
    });
    expect(request?.token).toMatch(/^[0-9a-f]{64}$/u);
    const config = JSON.parse(await readFile(join(home, ".scotty.json"), "utf8"));
    expect((await stat(join(home, ".scotty.json"))).mode & 0o777).toBe(0o600);
    expect(config).toEqual({
      version: 1,
      installationName: "home",
      profile: "personal",
      stackName: "Scotty-home",
      stage: "production",
      accountId: "0123456789abcdef0123456789abcdef",
      workerName: "scotty-home-worker",
      runnerWorkerName: "scotty-home-runner",
      containerName: "scotty-home-sandbox",
      kvTitle: "scotty-home-sessions",
      backupBucketName: "scotty-home-backups",
      host: "https://scotty-home-worker.example.workers.dev",
      token: request?.token,
    });
    expect(h.stdout.join("")).not.toContain(request?.token ?? "impossible");
    expect(h.json()).toEqual({
      configPath: join(home, ".scotty.json"),
      installationName: "home",
      profile: "personal",
      accountId: "0123456789abcdef0123456789abcdef",
      workerName: "scotty-home-worker",
      host: "https://scotty-home-worker.example.workers.dev",
      rootTokenRotated: true,
    });
  });

  test("recover inspects, confirms, rotates only the token, and stores a private mapping", async () => {
    const home = await temporaryDirectory();
    const inspected: Array<Parameters<NonNullable<CliDependencies["inspectInstallation"]>>[0]> = [];
    const recovered: Array<Parameters<NonNullable<CliDependencies["recoverInstallation"]>>[0]> = [];
    const result = {
      installationName: "home",
      profile: "default",
      stackName: "Legacy",
      stage: "production",
      accountId: "0123456789abcdef0123456789abcdef",
      workerName: "legacy-worker",
      runnerWorkerName: "legacy-runner",
      containerName: "legacy-container",
      kvTitle: "legacy-sessions",
      backupBucketName: "legacy-backups",
      host: "https://legacy-worker.example.workers.dev",
    } as const;
    const h = harness({
      home,
      inspectInstallation: async (input) => {
        inspected.push(input);
        return result;
      },
      recoverInstallation: async (input) => {
        recovered.push(input);
        return result;
      },
    });
    expect(
      await main(
        ["recover", "--name", "home", "--adoption-manifest", "/private/adoption.json", "--yes"],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    expect(inspected).toEqual([
      {
        installationName: "home",
        profile: "default",
        adoptionManifestPath: "/private/adoption.json",
      },
    ]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      installationName: "home",
      profile: "default",
      adoptionManifestPath: "/private/adoption.json",
      expectedAccountId: "0123456789abcdef0123456789abcdef",
      expectedWorkerName: "legacy-worker",
      expectedRunnerWorkerName: "legacy-runner",
      expectedContainerName: "legacy-container",
      expectedKvTitle: "legacy-sessions",
      expectedBackupBucketName: "legacy-backups",
    });
    expect(recovered[0]?.token).toMatch(/^[0-9a-f]{64}$/u);
    const config = JSON.parse(await readFile(join(home, ".scotty.json"), "utf8"));
    expect(config.adoptionManifestPath).toBe("/private/adoption.json");
    expect(config.token).toBe(recovered[0]?.token);
    expect(h.stdout.join("")).not.toContain(config.token);
  });

  test("deploy updates code without passing or changing the root token", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      join(home, ".scotty.json"),
      JSON.stringify({
        version: 1,
        installationName: "home",
        profile: "personal",
        host: "https://old.example",
        token: "root-secret",
      }),
    );
    let request: Parameters<NonNullable<CliDependencies["deployInstallation"]>>[0] | undefined;
    const h = harness({
      home,
      planInstallation: async () => ({
        installationName: "home",
        hasExistingResources: true,
        fingerprint: "plan-1",
        changes: [{ id: "Scotty-home/Worker", action: "update" }],
      }),
      deployInstallation: async (input) => {
        request = input;
        return {
          installationName: input.installationName,
          profile: input.profile,
          stackName: "Scotty-home",
          stage: "production",
          accountId: "0123456789abcdef0123456789abcdef",
          workerName: "scotty-home-worker",
          runnerWorkerName: "scotty-home-runner",
          containerName: "scotty-home-sandbox",
          kvTitle: "scotty-home-sessions",
          backupBucketName: "scotty-home-backups",
          host: "https://new.example/",
        };
      },
    });

    expect(await main(["deploy", "--yes"], h.deps)).toBe(EXIT.OK);
    expect(request).toEqual({
      installationName: "home",
      profile: "personal",
      expectedPlanFingerprint: "plan-1",
    });
    expect(request).not.toHaveProperty("token");
    const config = JSON.parse(await readFile(join(home, ".scotty.json"), "utf8"));
    expect(config.token).toBe("root-secret");
    expect(config.host).toBe("https://new.example");
    expect(h.json().rootTokenRotated).toBe(false);
  });

  test("deploy skips confirmation and apply when the plan has no changes", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      join(home, ".scotty.json"),
      JSON.stringify({
        version: 1,
        installationName: "home",
        profile: "default",
        token: "root-secret",
      }),
    );
    let applied = false;
    const h = harness({
      home,
      planInstallation: async () => ({
        installationName: "home",
        hasExistingResources: true,
        fingerprint: "plan-noop",
        changes: [],
      }),
      deployInstallation: async () => {
        applied = true;
        throw new Error("must not apply a no-op plan");
      },
    });

    expect(await main(["deploy"], h.deps)).toBe(EXIT.OK);
    expect(applied).toBe(false);
    expect(h.json()).toEqual({
      installationName: "home",
      changed: false,
      changes: [],
      rootTokenRotated: false,
    });
  });

  test("deploy requires confirmation only when a non-interactive plan has changes", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      join(home, ".scotty.json"),
      JSON.stringify({
        version: 1,
        installationName: "home",
        profile: "default",
        token: "root-secret",
      }),
    );
    const h = harness({
      home,
      planInstallation: async () => ({
        installationName: "home",
        hasExistingResources: true,
        fingerprint: "plan-2",
        changes: [{ id: "Scotty-home/Worker", action: "update" }],
      }),
    });

    expect(await main(["deploy"], h.deps)).toBe(EXIT.USAGE);
    expect(h.error().error.message).toBe("deploy requires --yes when the plan contains changes");
  });

  test("upgrade delegates to the signed updater and returns stable JSON", async () => {
    let request: Parameters<NonNullable<CliDependencies["upgradeCli"]>>[0] | undefined;
    const h = harness({
      upgradeCli: async (input) => {
        request = input;
        return { previousVersion: input.currentVersion, version: "9.8.7", updated: true };
      },
    });

    expect(await main(["upgrade"], h.deps)).toBe(EXIT.OK);
    expect(request).toMatchObject({ currentVersion: VERSION });
    expect(request?.executablePath).toBe(process.execPath);
    expect(h.json()).toEqual({
      previousVersion: VERSION,
      version: "9.8.7",
      updated: true,
    });
  });

  test("uninstall removes compute, retains data by default, and deletes local config", async () => {
    const home = await temporaryDirectory();
    const configPath = join(home, ".scotty.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        installationName: "home",
        profile: "personal",
        accountId: "0123456789abcdef0123456789abcdef",
        host: "https://worker.example",
        token: "root-secret",
      }),
    );
    let request: Parameters<NonNullable<CliDependencies["uninstallInstallation"]>>[0] | undefined;
    const h = harness({
      home,
      uninstallInstallation: async (input) => {
        request = input;
        return {
          installationName: input.installationName,
          deletedCompute: ["scotty-home-sandbox", "scotty-home-runner", "scotty-home-worker"],
          retainedData: ["scotty-home-sessions", "scotty-home-backups"],
          deletedData: [],
        };
      },
    });

    expect(await main(["uninstall", "--yes"], h.deps)).toBe(EXIT.OK);
    expect(request).toEqual({
      installationName: "home",
      profile: "personal",
      deleteData: false,
      expectedAccountId: "0123456789abcdef0123456789abcdef",
      expectedWorkerName: "scotty-home-worker",
      expectedRunnerWorkerName: "scotty-home-runner",
      expectedContainerName: "scotty-home-sandbox",
      expectedKvTitle: "scotty-home-sessions",
      expectedBackupBucketName: "scotty-home-backups",
    });
    expect(await Bun.file(configPath).exists()).toBe(false);
    expect(h.json()).toEqual({
      installationName: "home",
      deletedCompute: ["scotty-home-sandbox", "scotty-home-runner", "scotty-home-worker"],
      retainedData: ["scotty-home-sessions", "scotty-home-backups"],
      deletedData: [],
      configRemoved: true,
    });
  });

  test("uninstall passes the explicit data deletion choice", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      join(home, ".scotty.json"),
      JSON.stringify({
        version: 1,
        installationName: "home",
        profile: "default",
        accountId: "0123456789abcdef0123456789abcdef",
      }),
    );
    let deleteData = false;
    const h = harness({
      home,
      uninstallInstallation: async (input) => {
        deleteData = input.deleteData;
        return {
          installationName: input.installationName,
          deletedCompute: [],
          retainedData: [],
          deletedData: ["scotty-home-sessions", "scotty-home-backups"],
        };
      },
    });

    expect(await main(["uninstall", "--delete-data", "--yes"], h.deps)).toBe(EXIT.OK);
    expect(deleteData).toBe(true);
    expect(h.json().deletedData).toEqual(["scotty-home-sessions", "scotty-home-backups"]);
  });

  test("init never infers an installation name in a non-interactive shell", async () => {
    const h = harness();
    expect(await main(["init"], h.deps)).toBe(EXIT.USAGE);
    expect(h.error().error.message).toBe("init needs --name when stdin is not a TTY");

    const invalid = harness();
    expect(await main(["init", "--name", "Yesh Home"], invalid.deps)).toBe(EXIT.USAGE);
    expect(invalid.error().error.message).toContain("Installation name must be");
  });

  test("doctor validates managed installation metadata and root authentication", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      join(home, ".scotty.json"),
      JSON.stringify({
        version: 1,
        installationName: "home",
        profile: "personal",
        accountId: "0123456789abcdef0123456789abcdef",
        workerName: "scotty-home-worker",
        host: "https://worker.example",
        token: "root-secret",
      }),
    );
    let authorization: string | null = null;
    const h = harness({
      home,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        authorization = request.headers.get("authorization");
        return Response.json([]);
      },
    });
    expect(await main(["doctor"], h.deps)).toBe(EXIT.OK);
    expect(authorization).toBe("Bearer root-secret");
    expect(h.json()).toEqual({
      ok: true,
      mode: "managed",
      host: "https://worker.example",
      installationName: "home",
      profile: "personal",
      accountId: "0123456789abcdef0123456789abcdef",
      workerName: "scotty-home-worker",
    });
    expect(h.stdout.join("")).not.toContain("root-secret");
  });

  test("network and malformed responses fail without leaking implementation errors", async () => {
    const network = harness({
      fetch: async () => {
        throw new Error("socket exploded with secret details");
      },
    });
    expect(
      await main(["ls", "--host", "https://worker.example", "--token", "secret"], network.deps),
    ).toBe(EXIT.GENERIC);
    expect(network.error()).toEqual({
      error: {
        code: "network_error",
        message: "Could not reach the Scotty Worker",
        hint: "Check --host and your network, then retry.",
      },
    });

    const malformed = harness({ fetch: async () => new Response("not json", { status: 200 }) });
    expect(
      await main(["ls", "--host", "https://worker.example", "--token", "secret"], malformed.deps),
    ).toBe(EXIT.GENERIC);
    expect(malformed.error().error.code).toBe("invalid_response");

    const malformedFailure = harness({
      fetch: async () => new Response("not json", { status: 502 }),
    });
    expect(
      await main(
        ["ls", "--host", "https://worker.example", "--token", "secret"],
        malformedFailure.deps,
      ),
    ).toBe(EXIT.GENERIC);
    expect(malformedFailure.error()).toEqual({
      error: {
        code: "http_502",
        message: "Request failed with HTTP 502",
        hint: "Check the session state and Worker logs.",
      },
    });
  });

  test("ls exposes only the stable public projection", async () => {
    const session = {
      id: "s1",
      title: "Fix build",
      status: "warm",
      provider: "cloudflare",
      repo: "owner/project",
      defaultBranch: "dev",
      branch: "scotty/s1",
      createdAt: "2026-07-20T12:00:00Z",
      updatedAt: "2026-07-20T12:01:00Z",
      hardCapAt: "2026-07-20T16:00:00Z",
      projectedAt: "2026-07-20T12:01:01Z",
      agentState: "working",
      lastAgentEventAt: "2026-07-20T12:00:59Z",
      ageSeconds: 60,
      capRemainingSeconds: 14340,
      operation: { kind: "snapshot", nonce: "internal" },
      backup: { current: "must-not-leak" },
      webToken: "must-not-leak",
    };
    const h = harness({ fetch: async () => Response.json([session]) });
    expect(
      await main(["ls", "--host", "https://worker.example", "--token", "secret"], h.deps),
    ).toBe(EXIT.OK);
    expect(h.json()).toEqual([
      {
        id: "s1",
        title: "Fix build",
        status: "warm",
        provider: "cloudflare",
        repo: "owner/project",
        defaultBranch: "dev",
        branch: "scotty/s1",
        createdAt: "2026-07-20T12:00:00Z",
        updatedAt: "2026-07-20T12:01:00Z",
        hardCapAt: "2026-07-20T16:00:00Z",
        ageSeconds: 60,
        capRemainingSeconds: 14340,
        projectedAt: "2026-07-20T12:01:01Z",
        agentState: "working",
        lastAgentEventAt: "2026-07-20T12:00:59Z",
      },
    ]);
    expect(h.stdout.join("")).not.toContain("must-not-leak");
  });

  test("ls omits invalid optionals and applies failure defaults field by field", async () => {
    const session = {
      id: "s1",
      title: "Fix build",
      status: "failed",
      provider: "cloudflare",
      repo: "owner/project",
      defaultBranch: "dev",
      branch: "scotty/s1",
      createdAt: "2026-07-20T12:00:00Z",
      updatedAt: "2026-07-20T12:01:00Z",
      hardCapAt: "2026-07-20T16:00:00Z",
      ageSeconds: 60,
      capRemainingSeconds: 14340,
      projectedAt: null,
      codexThreadId: 42,
      failure: { code: 9, message: null, recoverable: "yes", secret: "must-not-leak" },
      secret: "must-not-leak",
    };
    const h = harness({ fetch: async () => Response.json([session]) });

    expect(
      await main(["ls", "--host", "https://worker.example", "--token", "secret"], h.deps),
    ).toBe(EXIT.OK);
    expect(h.json()).toEqual([
      {
        id: "s1",
        title: "Fix build",
        status: "failed",
        provider: "cloudflare",
        repo: "owner/project",
        defaultBranch: "dev",
        branch: "scotty/s1",
        createdAt: "2026-07-20T12:00:00Z",
        updatedAt: "2026-07-20T12:01:00Z",
        hardCapAt: "2026-07-20T16:00:00Z",
        ageSeconds: 60,
        capRemainingSeconds: 14340,
        failure: { code: "unknown", message: "Session failed", recoverable: false },
      },
    ]);
    expect(h.stdout.join("")).not.toContain("must-not-leak");
  });
});

describe("Pi auth commands", () => {
  test("sync locks, decodes, resolves, uploads, and confirms the complete Pi provider map", async () => {
    const home = await temporaryDirectory();
    const authDirectory = join(home, ".pi", "agent");
    const authPath = join(authDirectory, "auth.json");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(
      authPath,
      JSON.stringify({
        openai: { type: "api_key", key: "$OPENAI_TEST_KEY" },
        "openai-codex": {
          type: "oauth",
          access: "local-access",
          refresh: "local-refresh",
          expires: 0,
          accountId: "local-account",
        },
        anthropic: {
          type: "oauth",
          access: "anthropic-access",
          refresh: "anthropic-refresh",
          expires: 0,
        },
      }),
      { mode: 0o600 },
    );
    let uploaded: string | undefined;
    const requests: Request[] = [];
    const h = harness({
      home,
      env: {
        SCOTTY_HOST: "https://worker.example",
        SCOTTY_TOKEN: "worker-token",
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
        CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
        OPENAI_TEST_KEY: "resolved-openai-key",
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (new URL(request.url).hostname === "api.cloudflare.com") {
          const body = await request.json();
          uploaded = body.text;
          return Response.json({ success: true });
        }
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uploaded));
        return Response.json({
          sourceDigest: Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
          providers: [
            { id: "anthropic", type: "oauth", adapter: "unsupported" },
            { id: "openai", type: "api_key", adapter: "supported" },
            { id: "openai-codex", type: "oauth", adapter: "supported" },
          ],
        });
      },
    });

    expect(await main(["auth", "sync"], h.deps)).toBe(EXIT.OK);
    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer cloudflare-token");
    expect(requests[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/workers/scripts/scotty-worker/secrets`,
    );
    const normalized = JSON.parse(uploaded ?? "{}");
    expect(normalized.openai.key).toBe("resolved-openai-key");
    expect(normalized["openai-codex"].accountId).toBe("local-account");
    expect(normalized.anthropic.access).toBe("anthropic-access");
    expect(h.json()).toMatchObject({
      synchronized: true,
      worker: "scotty-worker",
      providers: [
        { id: "anthropic", adapter: "unsupported" },
        { id: "openai", adapter: "supported" },
        { id: "openai-codex", adapter: "supported" },
      ],
    });
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer worker-token");
    expect(JSON.stringify(h.json())).not.toContain("local-access");
    expect(JSON.stringify(h.json())).not.toContain("resolved-openai-key");
  });

  test("reseed --all-active targets only warm Cloudflare sessions", async () => {
    const requests: Request[] = [];
    const h = harness({
      env: { SCOTTY_HOST: "https://worker.example", SCOTTY_TOKEN: "worker-token" },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (new URL(request.url).pathname === "/api/sessions")
          return Response.json([
            {
              id: "warm-cloud",
              title: "Warm",
              status: "warm",
              provider: "cloudflare",
              repo: "owner/repo",
              defaultBranch: "main",
              branch: "scotty/warm",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              hardCapAt: "2026-01-01T04:00:00.000Z",
              ageSeconds: 1,
              capRemainingSeconds: 1,
            },
            {
              id: "sleeping-cloud",
              title: "Sleeping",
              status: "sleeping",
              provider: "cloudflare",
              repo: "owner/repo",
              defaultBranch: "main",
              branch: "scotty/sleeping",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              hardCapAt: "2026-01-01T04:00:00.000Z",
              ageSeconds: 1,
              capRemainingSeconds: 1,
            },
          ]);
        return Response.json({
          id: "warm-cloud",
          updatedAt: "2026-01-02T00:00:00.000Z",
          providers: [{ id: "openai-codex", type: "oauth", adapter: "supported" }],
        });
      },
    });

    expect(await main(["auth", "reseed", "--all-active"], h.deps)).toBe(EXIT.OK);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/sessions",
      "/api/sessions/warm-cloud/auth/reseed",
    ]);
    expect(h.json()).toEqual({
      reseeded: [
        {
          id: "warm-cloud",
          updatedAt: "2026-01-02T00:00:00.000Z",
          providers: [{ id: "openai-codex", type: "oauth", adapter: "supported" }],
        },
      ],
    });
  });
});

describe("commands and schemas", () => {
  test("maps auth, missing, wrong-state, usage, and generic failures to exits 4, 3, 5, 2, and 1", async () => {
    const cases = [
      [401, "unauthorized", EXIT.AUTH],
      [404, "not_found", EXIT.NOT_FOUND],
      [409, "wrong_state", EXIT.WRONG_STATE],
      [400, "bad_request", EXIT.USAGE],
      [500, "worker_failed", EXIT.GENERIC],
    ] as const;
    for (const [status, errorCode, exit] of cases) {
      const h = harness({
        fetch: async () =>
          Response.json({ error: { code: errorCode, message: "failed", hint: "act" } }, { status }),
      });
      expect(
        await main(
          ["resume", "s1", "--host", "https://worker.example", "--token", "secret"],
          h.deps,
        ),
      ).toBe(exit);
      expect(h.error()).toEqual({ error: { code: errorCode, message: "failed", hint: "act" } });
    }
  });

  test("preserves arbitrary error codes, status precedence, fallback, and redaction", async () => {
    for (const [status, reply, exit, expected] of [
      [
        418,
        { error: { code: "custom_teapot", message: "failed", hint: "act" } },
        EXIT.GENERIC,
        "custom_teapot",
      ],
      [
        403,
        { error: { code: "custom_denied", message: "failed", hint: "act" } },
        EXIT.AUTH,
        "custom_denied",
      ],
      [422, { error: { code: 12, message: null, hint: [] } }, EXIT.USAGE, "http_422"],
    ] as const) {
      const h = harness({ fetch: async () => Response.json(reply, { status }) });
      expect(
        await main(
          ["resume", "s1", "--host", "https://worker.example", "--token", "secret"],
          h.deps,
        ),
      ).toBe(exit);
      expect(h.error().error.code).toBe(expected);
      expect(h.stdout.join("")).toBe("");
    }

    const secret = "server-echoed-token";
    const redacted = harness({
      fetch: async () =>
        Response.json(
          { error: { code: "custom", message: `failed ${secret}`, hint: `remove ${secret}` } },
          { status: 500 },
        ),
    });
    expect(
      await main(
        ["resume", "s1", "--host", "https://worker.example", "--token", secret],
        redacted.deps,
      ),
    ).toBe(EXIT.GENERIC);
    expect(redacted.stderr.join("")).not.toContain(secret);
    expect(redacted.error().error).toEqual({
      code: "custom",
      message: "failed [REDACTED]",
      hint: "remove [REDACTED]",
    });

    const redactedCode = harness({
      fetch: async () =>
        Response.json({ error: { code: secret, message: "failed", hint: "act" } }, { status: 500 }),
    });
    expect(
      await main(
        ["resume", "s1", "--host", "https://worker.example", "--token", secret],
        redactedCode.deps,
      ),
    ).toBe(EXIT.GENERIC);
    expect(redactedCode.stderr.join("")).not.toContain(secret);
    expect(redactedCode.error().error.code).toBe("[REDACTED]");
  });

  test("snapshot and resume emit minimal stable schemas", async () => {
    for (const [args, reply, expected] of [
      [
        ["snapshot", "s1"],
        { id: "s1", status: "warm", backupId: "backup-1", ignored: true },
        { id: "s1", status: "warm", backupId: "backup-1" },
      ],
      [
        ["resume", "s1"],
        {
          id: "s1",
          status: "warm",
          branch: "scotty/s1",
          url: "https://worker.example/s/s1?t=secret",
          ignored: true,
        },
        {
          id: "s1",
          status: "warm",
          url: "https://worker.example/s/s1",
          branch: "scotty/s1",
        },
      ],
    ] as const) {
      const h = harness({ fetch: async () => Response.json(reply) });
      expect(
        await main([...args, "--host", "https://worker.example", "--token", "secret"], h.deps),
      ).toBe(EXIT.OK);
      expect(h.json()).toEqual(expected);
    }
  });

  test("operation optionals omit nulls and missing response IDs use the requested ID", async () => {
    for (const [args, reply, expected] of [
      [
        ["snapshot", "requested"],
        { status: "warm", id: null, backupId: null, url: null, branch: null, ignored: true },
        { id: "requested", status: "warm" },
      ],
      [
        ["resume", "requested"],
        { status: "warm", url: null, branch: null, backupId: null, ignored: true },
        { id: "requested", status: "warm" },
      ],
    ] as const) {
      const h = harness({ fetch: async () => Response.json(reply) });
      expect(
        await main([...args, "--host", "https://worker.example", "--token", "secret"], h.deps),
      ).toBe(EXIT.OK);
      expect(h.json()).toEqual(expected);
    }
  });

  test("removed commands and top-level lifecycle aliases fail as unknown commands", async () => {
    for (const command of ["pr", "publish", "up", "down", "vaporize"]) {
      const h = harness();
      expect(await main([command, "s1"], h.deps)).toBe(EXIT.USAGE);
      expect(h.error().error.code).toBe("bad_usage");
      expect(h.stderr.join("")).toContain(`Unknown command: ${command}`);
    }
  });

  test("beam up hard-cuts the old command and requires title, repository, and provider", async () => {
    const removed = harness();
    expect(
      await main(
        [
          "up",
          "fix",
          "--repo",
          "owner/project",
          "--provider",
          "cloudflare",
          "--detach",
          "--host",
          "https://worker.example",
          "--token",
          "secret",
        ],
        removed.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(removed.error().error.message).toBe("Unknown command: up");

    const missingTitle = harness();
    expect(
      await main(
        [
          "beam",
          "up",
          "fix",
          "--repo",
          "owner/project",
          "--provider",
          "cloudflare",
          "--detach",
          "--host",
          "https://worker.example",
          "--token",
          "secret",
        ],
        missingTitle.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(missingTitle.error().error.message).toContain("--title");

    const h = harness();
    expect(
      await main(
        [
          "beam",
          "up",
          "fix",
          "--title",
          "Fix build",
          "--detach",
          "--host",
          "https://worker.example",
          "--token",
          "secret",
        ],
        h.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(h.error().error).toMatchObject({
      code: "bad_usage",
      message: "--repo OWNER/NAME is required",
    });

    const missingProvider = harness();
    expect(
      await main(
        [
          "beam",
          "up",
          "fix",
          "--title",
          "Fix build",
          "--repo",
          "owner/project",
          "--detach",
          "--host",
          "https://worker.example",
          "--token",
          "secret",
        ],
        missingProvider.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(missingProvider.error().error.message).toBe("--provider cloudflare is required");

    const unsupportedProvider = harness();
    expect(
      await main(
        [
          "beam",
          "up",
          "fix",
          "--title",
          "Fix build",
          "--repo",
          "owner/project",
          "--provider",
          "box",
          "--detach",
          "--host",
          "https://worker.example",
          "--token",
          "secret",
        ],
        unsupportedProvider.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(unsupportedProvider.error().error.message).toBe("--provider must be cloudflare");
  });

  test("beam up strips same-origin tokens and rejects cross-origin session URLs", async () => {
    const tokenized = harness({
      fetch: async () =>
        Response.json({
          id: "s1",
          title: "Fix build",
          url: "https://worker.example/s/s1?t=server-secret#fragment",
          branch: "scotty/s1",
          provider: "cloudflare",
          status: "warm",
          internal: "must-not-leak",
        }),
    });
    expect(
      await main(
        [
          "beam",
          "up",
          "fix",
          "--title",
          "Fix build",
          "--repo",
          "owner/project",
          "--provider",
          "cloudflare",
          "--detach",
          "--host",
          "https://worker.example",
          "--token",
          "secret",
        ],
        tokenized.deps,
      ),
    ).toBe(EXIT.OK);
    expect(tokenized.json()).toEqual({
      id: "s1",
      title: "Fix build",
      url: "https://worker.example/s/s1",
      branch: "scotty/s1",
      provider: "cloudflare",
      status: "warm",
    });

    const crossOrigin = harness({
      fetch: async () =>
        Response.json({
          id: "s1",
          title: "Fix build",
          url: "https://attacker.example/s/s1?t=secret",
          branch: "scotty/s1",
          provider: "cloudflare",
          status: "warm",
        }),
    });
    expect(
      await main(
        [
          "beam",
          "up",
          "fix",
          "--title",
          "Fix build",
          "--repo",
          "owner/project",
          "--provider",
          "cloudflare",
          "--detach",
          "--host",
          "https://worker.example",
          "--token",
          "secret",
        ],
        crossOrigin.deps,
      ),
    ).toBe(EXIT.GENERIC);
    expect(crossOrigin.stdout.join("")).toBe("");
    expect(crossOrigin.error().error.code).toBe("invalid_response");

    const userInfo = harness({
      fetch: async () =>
        Response.json({
          id: "s1",
          title: "Fix build",
          url: "https://url-secret@worker.example/s/s1",
          branch: "scotty/s1",
          provider: "cloudflare",
          status: "warm",
        }),
    });
    expect(
      await main(
        [
          "beam",
          "up",
          "fix",
          "--title",
          "Fix build",
          "--repo",
          "owner/project",
          "--provider",
          "cloudflare",
          "--detach",
          "--host",
          "https://worker.example",
          "--token",
          "secret",
        ],
        userInfo.deps,
      ),
    ).toBe(EXIT.GENERIC);
    expect(userInfo.stdout.join("")).toBe("");
    expect(userInfo.stderr.join("")).not.toContain("url-secret");
  });

  test("non-TTY vaporize never prompts and sends DELETE", async () => {
    let method = "";
    const h = harness({
      fetch: async (_input, init) => {
        method = init?.method || "GET";
        return Response.json({ id: "s1", status: "gone", credential: "must-not-leak" });
      },
    });
    expect(
      await main(
        ["beam", "vaporize", "s1", "--host", "https://worker.example", "--token", "secret"],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    expect(method).toBe("DELETE");
    expect(h.prompts()).toBe(0);
    expect(h.json()).toEqual({ id: "s1", status: "gone" });
    expect(h.stdout.join("")).not.toContain("must-not-leak");
  });

  test("vaporize requires the exact requested ID and literal gone status", async () => {
    for (const reply of [
      { id: "different", status: "gone" },
      { id: "s1", status: "sleeping" },
    ]) {
      const h = harness({ fetch: async () => Response.json(reply) });
      expect(
        await main(
          [
            "beam",
            "vaporize",
            "s1",
            "--yes",
            "--host",
            "https://worker.example",
            "--token",
            "secret",
          ],
          h.deps,
        ),
      ).toBe(EXIT.GENERIC);
      expect(h.stdout.join("")).toBe("");
      expect(h.error().error.code).toBe("invalid_response");
    }
  });

  test("attach opens a clean URL and never gives the browser the root token", async () => {
    let opened = "";
    const h = harness({
      openBrowser: async (url) => {
        opened = url;
      },
    });
    expect(
      await main(["attach", "s1", "--host", "https://worker.example", "--token", "secret"], h.deps),
    ).toBe(EXIT.OK);
    expect(opened).toBe("https://worker.example/s/s1");
    expect(h.json()).toEqual({ id: "s1", url: "https://worker.example/s/s1", opened: true });
    expect(h.stdout.join("")).not.toContain("secret");
  });

  test("beam up strips server query data before opening the session browser", async () => {
    let opened = "";
    const h = harness({
      fetch: async () =>
        Response.json({
          id: "s1",
          title: "Fix build",
          url: "https://worker.example/s/s1?t=legacy-root#fragment",
          branch: "scotty/s1",
          provider: "cloudflare",
          status: "warm",
        }),
      openBrowser: async (url) => {
        opened = url;
      },
    });
    expect(
      await main(
        [
          "beam",
          "up",
          "fix it",
          "--title",
          "Fix build",
          "--repo",
          "owner/project",
          "--provider",
          "cloudflare",
          "--host",
          "https://worker.example",
          "--token",
          "root-secret",
        ],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    expect(opened).toBe("https://worker.example/s/s1");
    expect(h.stdout.join("")).not.toContain("legacy-root");
    expect(h.stdout.join("")).not.toContain("root-secret");
  });

  test("owner recover opens the capability but emits only its expiry", async () => {
    const rootToken = "protected-root-token";
    const recoveryCredential =
      "scotty_recovery.111111111111.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const expiresAt = new Date(Date.now() + 5 * 60 * 1_000).toISOString();
    let opened = "";
    let request: Request | undefined;
    const h = harness({
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          url: `https://worker.example/recover#token=${recoveryCredential}`,
          expiresAt,
        });
      },
      openBrowser: async (url) => {
        opened = url;
      },
    });

    expect(
      await main(
        ["owner", "recover", "--host", "https://worker.example", "--token", rootToken, "--json"],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    expect(request?.url).toBe("https://worker.example/api/auth/recovery-grants");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${rootToken}`);
    expect(request?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(opened).toBe(`https://worker.example/recover#token=${recoveryCredential}`);
    expect(h.json()).toEqual({ opened: true, expiresAt });
    expect(h.stdout.join("")).not.toContain(rootToken);
    expect(h.stdout.join("")).not.toContain(recoveryCredential);
    expect(h.stderr.join("")).not.toContain(rootToken);
    expect(h.stderr.join("")).not.toContain(recoveryCredential);
  });

  test("owner recover rejects unsafe or malformed capability responses without opening them", async () => {
    const credential = "scotty_recovery.111111111111.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const validExpiry = new Date(Date.now() + 5 * 60 * 1_000).toISOString();
    const replies = [
      {
        url: `https://attacker.example/recover#token=${credential}`,
        expiresAt: validExpiry,
      },
      {
        url: `https://worker.example/not-recover#token=${credential}`,
        expiresAt: validExpiry,
      },
      {
        url: `https://worker.example/recover?leak=1#token=${credential}`,
        expiresAt: validExpiry,
      },
      {
        url: `https://worker.example/recover#token=${credential}&extra=1`,
        expiresAt: validExpiry,
      },
      {
        url: "https://worker.example/recover#token=protected-root-token",
        expiresAt: validExpiry,
      },
      {
        url: `https://worker.example/recover#token=${credential}`,
        expiresAt: "not-a-date",
      },
      {
        url: `https://worker.example/recover#token=${credential}`,
        expiresAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
      },
    ];

    for (const reply of replies) {
      let opened = false;
      const h = harness({
        fetch: async () => Response.json(reply),
        openBrowser: async () => {
          opened = true;
        },
      });
      expect(
        await main(
          [
            "owner",
            "recover",
            "--host",
            "https://worker.example",
            "--token",
            "protected-root-token",
          ],
          h.deps,
        ),
      ).toBe(EXIT.GENERIC);
      expect(opened).toBe(false);
      expect(h.stdout.join("")).toBe("");
      expect(h.stderr.join("")).not.toContain(credential);
      expect(h.stderr.join("")).not.toContain("protected-root-token");
    }
  });
});

function tarFile(entries: Array<[string, Uint8Array]>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const [name, contents] of entries) {
    const header = new Uint8Array(512);
    header.set(encoder.encode(name).subarray(0, 100), 0);
    header.set(encoder.encode("0000600\0"), 100);
    header.set(encoder.encode("0000000\0"), 108);
    header.set(encoder.encode("0000000\0"), 116);
    header.set(encoder.encode(contents.length.toString(8).padStart(11, "0") + "\0"), 124);
    header.set(encoder.encode("00000000000\0"), 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
    blocks.push(header, contents, new Uint8Array((512 - (contents.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const length = blocks.reduce((sum, block) => sum + block.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.length;
  }
  return result;
}

describe("beam down and embedded skill", () => {
  test("down fetches the branch and writes rollout mode 0600", async () => {
    const home = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const threadId = "019c7714-3b77-74d1-9866-e1f484aae2ab";
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const archive = tarFile([
      [
        "metadata.json",
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            id: "s1",
            repo: "owner/project",
            branch: "scotty/s1",
            sha,
            codexThreadId: threadId,
            rolloutFile: `rollout-2026-07-20T12-00-00-${threadId}.jsonl`,
            rolloutPath: `sessions/2026/07/20/rollout-2026-07-20T12-00-00-${threadId}.jsonl`,
            internal: "must-not-leak",
          }),
        ),
      ],
      [
        `sessions/2026/07/20/rollout-2026-07-20T12-00-00-${threadId}.jsonl`,
        new TextEncoder().encode('{"type":"session_meta"}\n'),
      ],
    ]);
    const commands: string[][] = [];
    const h = harness({
      home,
      cwd,
      fetch: async () =>
        new Response(archive, { status: 200, headers: { "content-type": "application/x-tar" } }),
      run: async (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: command[1] === "rev-parse" ? `${sha}\n` : "", stderr: "" };
      },
    });

    expect(
      await main(
        ["beam", "down", "s1", "--host", "https://worker.example", "--token", "secret"],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    expect(commands).toEqual([
      ["git", "fetch", "origin", "scotty/s1"],
      ["git", "rev-parse", "FETCH_HEAD"],
    ]);
    const result = h.json();
    expect(result.branch).toBe("scotty/s1");
    expect(result.sha).toBe(sha);
    expect(result.resumeCmd).toContain(`codex resume '${threadId}' -C`);
    expect((await stat(result.rolloutPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(result.rolloutPath, "utf8")).toBe('{"type":"session_meta"}\n');
    expect(h.stdout.join("")).not.toContain("must-not-leak");
  });

  test("down accepts legacy JSON rollout metadata", async () => {
    const home = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const threadId = "019c7714-3b77-74d1-9866-e1f484aae2ab";
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const rolloutName = `rollout-2026-07-20T12-00-00-${threadId}.jsonl`;
    const h = harness({
      home,
      cwd,
      fetch: async () =>
        Response.json({
          branch: "scotty/s1",
          sha,
          rolloutBase64: Buffer.from('{"type":"session_meta"}\n').toString("base64"),
          rolloutName,
          unknownCredential: "must-not-leak",
        }),
      run: async (command) => ({
        exitCode: 0,
        stdout: command[1] === "rev-parse" ? `${sha}\n` : "",
        stderr: "",
      }),
    });

    expect(
      await main(
        ["beam", "down", "s1", "--host", "https://worker.example", "--token", "secret"],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    const result = h.json();
    expect(result).toEqual({
      branch: "scotty/s1",
      sha,
      rolloutPath: join(home, ".codex", "sessions", "2026", "07", "20", rolloutName),
      resumeCmd: `codex resume '${threadId}' -C '${cwd}'`,
    });
    expect(h.stdout.join("")).not.toContain("must-not-leak");
  });

  test("down emits explicit null rollout fields when the production manifest has no rollout", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const archive = tarFile([
      [
        "metadata.json",
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            id: "s1",
            repo: "owner/project",
            branch: "scotty/s1",
            sha,
          }),
        ),
      ],
    ]);
    const h = harness({
      fetch: async () =>
        new Response(archive, { headers: { "content-type": "application/x-tar" } }),
      run: async (command) => ({
        exitCode: 0,
        stdout: command[1] === "rev-parse" ? `${sha}\n` : "",
        stderr: "",
      }),
    });

    expect(
      await main(
        ["beam", "down", "s1", "--host", "https://worker.example", "--token", "secret"],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    expect(h.json()).toEqual({
      branch: "scotty/s1",
      sha,
      rolloutPath: null,
      resumeCmd: null,
    });
  });

  test("down rejects an unsafe branch before invoking git", async () => {
    const archive = tarFile([
      [
        "metadata.json",
        new TextEncoder().encode(
          JSON.stringify({
            branch: "--upload-pack=evil",
            sha: "0123456789abcdef0123456789abcdef01234567",
          }),
        ),
      ],
    ]);
    let ran = false;
    const h = harness({
      fetch: async () =>
        new Response(archive, { headers: { "content-type": "application/x-tar" } }),
      run: async () => {
        ran = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(
      await main(
        ["beam", "down", "s1", "--host", "https://worker.example", "--token", "secret"],
        h.deps,
      ),
    ).toBe(EXIT.GENERIC);
    expect(ran).toBe(false);
    expect(h.error().error.code).toBe("invalid_response");
  });

  test("down rejects an unsafe path declared only in metadata", async () => {
    const threadId = "019c7714-3b77-74d1-9866-e1f484aae2ab";
    const archive = tarFile([
      [
        "metadata.json",
        new TextEncoder().encode(
          JSON.stringify({
            branch: "scotty/s1",
            sha: "0123456789abcdef0123456789abcdef01234567",
            codexThreadId: threadId,
            rolloutPath: "../../escape.jsonl",
          }),
        ),
      ],
      [`rollout/rollout-2026-07-20T12-00-00-${threadId}.jsonl`, new TextEncoder().encode("{}\n")],
    ]);
    let ran = false;
    const h = harness({
      fetch: async () =>
        new Response(archive, { headers: { "content-type": "application/x-tar" } }),
      run: async () => {
        ran = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(
      await main(
        ["beam", "down", "s1", "--host", "https://worker.example", "--token", "secret"],
        h.deps,
      ),
    ).toBe(EXIT.GENERIC);
    expect(ran).toBe(false);
    expect(h.error().error.code).toBe("invalid_archive");
  });

  test("skills prints the exact embedded source as Markdown", async () => {
    const skills = harness();
    const source = await readFile(new URL("../skills/scotty/SKILL.md", import.meta.url), "utf8");
    expect(await main(["skills"], skills.deps)).toBe(EXIT.OK);
    expect(EMBEDDED_SKILL).toBe(source);
    expect(skills.stdout.join("")).toBe(EMBEDDED_SKILL);
  });

  test("skills rejects JSON wrapping and filesystem installation", async () => {
    const json = harness();
    const install = harness();
    expect(await main(["skills", "--json"], json.deps)).toBe(EXIT.USAGE);
    expect(await main(["skills", "install"], install.deps)).toBe(EXIT.USAGE);
    expect(json.error().error.code).toBe("bad_usage");
    expect(install.error().error.code).toBe("bad_usage");
  });

  test("tools list returns the checked-in standard manifest without credentials", async () => {
    let fetched = false;
    const h = harness({
      fetch: async () => {
        fetched = true;
        return Response.json({});
      },
    });

    expect(await main(["tools", "list", "--json"], h.deps)).toBe(EXIT.OK);
    expect(h.json()).toEqual(STANDARD_TOOLSET);
    const toolNames = h.json().tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).not.toContain("tree");
    expect(toolNames).not.toContain("duckdb");
    expect(toolNames).not.toContain("agent-browser");
    expect(toolNames).not.toContain("Chromium");
    expect(toolNames).toContain("build-essential");
    expect(toolNames).toContain("pkg-config");
    expect(fetched).toBe(false);
  });

  test("tools doctor probes sequentially and reports pinned version mismatches", async () => {
    const probes: string[][] = [];
    const h = harness({
      run: async (command) => {
        probes.push(command);
        const tool = STANDARD_TOOLSET.tools.find(
          (candidate) => candidate.probe.join("\0") === command.join("\0"),
        );
        return {
          exitCode: 0,
          stdout:
            tool?.name === "qsv"
              ? "qsv 0.0.0\n"
              : `${tool?.name ?? command[0]} ${tool?.expectedVersion ?? "image"}\n`,
          stderr: "",
        };
      },
    });

    expect(await main(["tools", "doctor", "--json"], h.deps)).toBe(EXIT.GENERIC);
    expect(probes).toEqual(STANDARD_TOOLSET.tools.map((tool) => [...tool.probe]));
    expect(h.json().ok).toBe(false);
    expect(h.json().tools.find((tool: { name: string }) => tool.name === "qsv")).toEqual({
      name: "qsv",
      status: "version-mismatch",
      version: "qsv 0.0.0",
      expectedVersion: "21.1.0",
    });
  });

  test("tools doctor reports missing commands and succeeds when every probe passes", async () => {
    const missing = harness({
      run: async () => Promise.reject(new Error("ENOENT")),
    });
    expect(await main(["tools", "doctor", "--json"], missing.deps)).toBe(EXIT.GENERIC);
    expect(
      missing.json().tools.every((tool: { status: string }) => tool.status === "missing"),
    ).toBe(true);

    const healthy = harness({
      run: async (command) => {
        const tool = STANDARD_TOOLSET.tools.find(
          (candidate) => candidate.probe.join("\0") === command.join("\0"),
        );
        return {
          exitCode: 0,
          stdout: `${tool?.name ?? command[0]} ${tool?.expectedVersion ?? "image"}\n`,
          stderr: "",
        };
      },
    });
    expect(await main(["tools", "doctor", "--json"], healthy.deps)).toBe(EXIT.OK);
    expect(healthy.json().ok).toBe(true);
  });
});
