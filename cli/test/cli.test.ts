import { strict as nodeAssert } from "node:assert";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { PreviewCleanupOwnershipError } from "../../infra/preview-ownership";
import { AuthError } from "alchemy/Auth";
import { EXIT, main, VERSION, type CliDependencies } from "../scotty";
import { BeamUpRequestSchema } from "../src/schemas";
import { scottyTomlConfigPath } from "../src/scotty-config";
import { managedInstallationPath } from "../src/managed-installation-path.mjs";
import { deploymentPlanPath } from "../src/deployment-plan";
import { Schema } from "effect";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "scotty-cli-test-"));
  await mkdir(join(path, ".config", "scotty"), { recursive: true });
  temporaryDirectories.push(path);
  return path;
}

async function writeScottyToml(
  home: string,
  roots: Partial<
    Record<"skills" | "packages" | "tools" | "extensions", ReadonlyArray<string>>
  > = {},
): Promise<void> {
  await mkdir(join(home, ".config", "scotty"), { recursive: true });
  const array = (name: "skills" | "packages" | "tools" | "extensions"): string =>
    JSON.stringify(roots[name] ?? []);
  await writeFile(
    scottyTomlConfigPath(home),
    [
      "version = 1",
      "",
      "[sync]",
      `skills = ${array("skills")}`,
      `packages = ${array("packages")}`,
      `tools = ${array("tools")}`,
      `extensions = ${array("extensions")}`,
      "",
      "[repos]",
      "allowed = []",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function harness(overrides: Partial<CliDependencies> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let prompts = 0;
  const deps: Partial<CliDependencies> = {
    env: { SCOTTY_TOKEN: "secret" },
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

function rejected<T = never>(message: string): Promise<T> {
  return new Promise((_, reject) => reject(new Error(message)));
}

async function planDeployment(h: ReturnType<typeof harness>): Promise<void> {
  expect(await main(["deploy", "--plan"], h.deps)).toBe(EXIT.OK);
  h.stdout.length = 0;
  h.stderr.length = 0;
}

const decodeBeamUpRequest = Schema.decodeUnknownSync(BeamUpRequestSchema);

const pendingUpPath = (home: string, host: string, body: unknown): string => {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([host, body]))
    .digest("hex");
  return join(home, ".scotty", "pending-up", `${fingerprint}.json`);
};

const beamArgs = (repo = "owner/project") =>
  [
    "beam",
    "fix it",
    "--title",
    "Fix build",
    "--repo",
    repo,
    "--provider",
    "cloudflare",
    "--detach",
    "--host",
    "https://worker.example",
  ] as const;

const HATCH_INIT_ARGS = [
  "--preview-base",
  "preview.scotty.example",
  "--preview-zone-id",
  "0123456789abcdef0123456789abcdef",
] as const;

const managedConfig = () => ({
  installationName: "home",
  profile: "default",
  stackName: "Scotty-home",
  stage: "production",
  accountId: "0123456789abcdef0123456789abcdef",
  workerName: "scotty-home-worker",
  runnerWorkerName: "scotty-home-runner",
  containerName: "scotty-home-sandbox",
  kvTitle: "scotty-home-sessions",
  backupBucketName: "scotty-home-backups",
  previewBase: "preview.scotty.example",
  previewZoneId: "0123456789abcdef0123456789abcdef",
  evidenceEnabled: true as const,
  host: "https://worker.example",
  token: "root-secret",
});

function acceptingSandboxSyncFetch(): NonNullable<CliDependencies["fetch"]> {
  let revision = 0;
  let activeDigest: string | null = null;
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/api/sandbox/configuration")
      return Response.json({ revision, activeDigest });
    const match = url.pathname.match(/^\/api\/sandbox\/bundles\/([0-9a-f]{64})$/u);
    if (match && request.method === "PUT") {
      revision += 1;
      activeDigest = match[1] ?? null;
      return Response.json({ revision, activeDigest });
    }
    return Response.json({ error: { code: "not_found", message: "missing" } }, { status: 404 });
  };
}

describe("configuration and transport", () => {
  test("uses only the managed installation pointer path", async () => {
    const home = await temporaryDirectory();
    expect(managedInstallationPath(home)).toBe(
      join(home, ".config", "scotty", "installation.json"),
    );
    await writeFile(
      join(home, ".scotty.json"),
      JSON.stringify({ host: "https://legacy.example", token: "legacy-token" }),
      { mode: 0o600 },
    );
    const h = harness({ home, env: {}, fetch: async () => Response.json([]) });
    expect(await main(["list"], h.deps)).toBe(EXIT.USAGE);
    expect(h.error().error.code).toBe("bad_usage");
  });
  test("flags override env and config; non-TTY output is stable JSON", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      managedInstallationPath(home),
      JSON.stringify({ host: "https://config.example", token: "config-token" }),
      { mode: 0o600 },
    );
    const tokenPath = join(home, "root-token");
    await writeFile(tokenPath, "flag-token\n", { mode: 0o600 });
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
        "--token-file",
        tokenPath,
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

  test("rejects the removed raw token flag and unsafe token files", async () => {
    const home = await temporaryDirectory();
    const leaked = harness({ home });
    expect(
      await main(
        ["list", "--host", "https://worker.example", "--token", "raw-secret"],
        leaked.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(leaked.stderr.join("")).not.toContain("raw-secret");

    const tokenPath = join(home, "token");
    await writeFile(tokenPath, "file-secret\n", { mode: 0o644 });
    const exposed = harness({ home, env: {} });
    expect(
      await main(
        ["list", "--host", "https://worker.example", "--token-file", tokenPath],
        exposed.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(exposed.error().error.code).toBe("token_file_invalid");
    expect(exposed.stderr.join("")).not.toContain("file-secret");

    await chmod(tokenPath, 0o600);
    await writeFile(tokenPath, "", { mode: 0o600 });
    const empty = harness({ home, env: {} });
    expect(
      await main(
        ["list", "--host", "https://worker.example", "--token-file", tokenPath],
        empty.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(empty.error().error.message).toBe("Scotty token file is empty");
  });

  test("beam converts the human cap to the Worker contract", async () => {
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
        ],
        invalid.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(invalid.error().error.code).toBe("bad_usage");
  });

  test("beam preserves human output and opens the clean session URL", async () => {
    let opened = "";
    const h = harness({
      stdoutIsTTY: true,
      fetch: async () =>
        Response.json({
          id: "s1",
          title: "Fix build",
          url: "https://worker.example/s/s1",
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
          "fix it",
          "--title",
          "Fix build",
          "--repo",
          "owner/project",
          "--provider",
          "cloudflare",
          "--host",
          "https://worker.example",
        ],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    expect(h.stdout.join("")).toBe("s1  warm  scotty/s1\nhttps://worker.example/s/s1\n");
    expect(opened).toBe("https://worker.example/s/s1");
  });

  test("beam forwards --new-repo and defaults the request field to false", async () => {
    let body: typeof BeamUpRequestSchema.Type | undefined;
    const h = harness({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        body = decodeBeamUpRequest(await request.json());
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
          "fix it",
          "--title",
          "Fix build",
          "--repo",
          "owner/project",
          "--provider",
          "cloudflare",
          "--new-repo",
          "--detach",
          "--host",
          "https://worker.example",
        ],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    expect(body?.newRepo).toBe(true);
  });

  test("beam rejects URL-normalizing repository path segments", async () => {
    const args = [
      "beam",
      "fix it",
      "--title",
      "Fix build",
      "--provider",
      "cloudflare",
      "--detach",
      "--host",
      "https://worker.example",
    ];
    for (const repo of ["./project", "../project", "owner/.", "owner/.."]) {
      const h = harness();
      expect(await main([...args, "--repo", repo], h.deps)).toBe(EXIT.USAGE);
      expect(h.error().error.message).toBe("--repo must be OWNER/NAME");
    }
  });

  test("beam reuses a pending idempotency key after an ambiguous network failure", async () => {
    const home = await temporaryDirectory();
    const keys: string[] = [];
    let requests = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      keys.push(request.headers.get("idempotency-key") ?? "");
      requests += 1;
      if (requests === 1) return rejected("connection dropped after create");
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
    ];

    expect(await main(args, harness({ home, fetch }).deps)).toBe(EXIT.GENERIC);
    expect(await main(args, harness({ home, fetch }).deps)).toBe(EXIT.OK);
    expect(await main(args, harness({ home, fetch }).deps)).toBe(EXIT.OK);

    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  test("beam retries once with a fresh idempotency key after a vaporized-session conflict", async () => {
    const home = await temporaryDirectory();
    const host = "https://worker.example";
    const body = {
      title: "Fix build",
      prompt: "fix it",
      provider: "cloudflare",
      repo: "owner/project",
    };
    const staleKey = "11111111-1111-4111-8111-111111111111";
    await mkdir(join(home, ".scotty", "pending-up"), { recursive: true });
    await writeFile(
      pendingUpPath(home, host, body),
      `${JSON.stringify({
        key: staleKey,
        createdAt: new Date().toISOString(),
      })}\n`,
    );

    const keys: string[] = [];
    let createRequests = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/api/sessions" && request.method === "POST") {
        keys.push(request.headers.get("idempotency-key") ?? "");
        createRequests += 1;
        if (createRequests === 1) {
          return Response.json(
            {
              error: {
                code: "conflict",
                message: "Session abcdef012345 already exists",
                hint: "Check the session state and Worker logs.",
              },
            },
            { status: 409 },
          );
        }
        return Response.json({
          id: "s2",
          title: "Fix build",
          url: "https://worker.example/s/s2",
          branch: "scotty/s2",
          provider: "cloudflare",
          status: "warm",
        });
      }
      if (url.pathname === "/api/sessions/abcdef012345" && request.method === "GET") {
        return Response.json(
          { error: { code: "not_found", message: "Session abcdef012345 is gone" } },
          { status: 404 },
        );
      }
      return Response.json({ error: { code: "not_found", message: "missing" } }, { status: 404 });
    };

    const h = harness({ home, fetch });
    expect(await main([...beamArgs()], h.deps)).toBe(EXIT.OK);
    expect(createRequests).toBe(2);
    expect(keys).toEqual([staleKey, expect.stringMatching(/^[0-9a-f-]{36}$/u)]);
    expect(keys[1]).not.toBe(staleKey);
    await expect(readFile(pendingUpPath(home, host, body))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("beam keeps a genuine create conflict when the session still exists", async () => {
    const home = await temporaryDirectory();
    let createRequests = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/api/sessions" && request.method === "POST") {
        createRequests += 1;
        return Response.json(
          {
            error: {
              code: "conflict",
              message: "Session abcdef012345 already exists",
              hint: "Check the session state and Worker logs.",
            },
          },
          { status: 409 },
        );
      }
      if (url.pathname === "/api/sessions/abcdef012345" && request.method === "GET") {
        return Response.json({
          id: "abcdef012345",
          title: "Fix build",
          status: "warm",
          provider: "cloudflare",
          repo: "owner/project",
          defaultBranch: "main",
          branch: "scotty/abcdef012345",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          hardCapAt: "2026-01-02T00:00:00.000Z",
          ageSeconds: 0,
          capRemainingSeconds: 86_400,
        });
      }
      return Response.json({ error: { code: "not_found", message: "missing" } }, { status: 404 });
    };

    const h = harness({ home, fetch });
    expect(await main([...beamArgs()], h.deps)).toBe(EXIT.WRONG_STATE);
    expect(createRequests).toBe(1);
    expect(h.error()).toEqual({
      error: {
        code: "conflict",
        message: "Session abcdef012345 already exists",
        hint: "Check the session state and Worker logs.",
      },
    });
  });

  test("env overrides config and config is the final fallback", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      managedInstallationPath(home),
      JSON.stringify({ host: "https://config.example", token: "config-token" }),
      { mode: 0o600 },
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
    expect(await main(["list"], h.deps)).toBe(EXIT.OK);

    const fallback = harness({
      home,
      env: {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seen.push(`${request.url} ${request.headers.get("authorization")}`);
        return Response.json([]);
      },
    });
    expect(await main(["list"], fallback.deps)).toBe(EXIT.OK);
    expect(seen).toEqual([
      "https://env.example/api/sessions Bearer env-token",
      "https://config.example/api/sessions Bearer config-token",
    ]);
  });

  test("rejects unsafe and symlinked config files", async () => {
    const home = await temporaryDirectory();
    const configPath = managedInstallationPath(home);
    await writeFile(
      configPath,
      JSON.stringify({ host: "https://worker.example", token: "root-secret" }),
      { mode: 0o600 },
    );
    await chmod(configPath, 0o644);
    const exposed = harness({ home });
    expect(await main(["list"], exposed.deps)).toBe(EXIT.USAGE);
    expect(exposed.error().error.code).toBe("config_permissions");

    await rm(configPath);
    const target = join(home, "private-config.json");
    await writeFile(
      target,
      JSON.stringify({ host: "https://worker.example", token: "root-secret" }),
      { mode: 0o600 },
    );
    await symlink(target, configPath);
    const linked = harness({ home });
    expect(await main(["list"], linked.deps)).toBe(EXIT.USAGE);
    expect(linked.error().error.code).toBe("config_permissions");
    expect(linked.stderr.join("")).not.toContain("root-secret");
  });

  test("complete overrides bypass a malformed config for stateless agents", async () => {
    const home = await temporaryDirectory();
    await writeFile(managedInstallationPath(home), "not-json", { mode: 0o600 });
    const h = harness({ home, fetch: async () => Response.json([]) });
    expect(await main(["list", "--host", "https://worker.example"], h.deps)).toBe(EXIT.OK);
    expect(h.json()).toEqual([]);
  });

  test("config fields decode independently and unknown fields are ignored", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      managedInstallationPath(home),
      JSON.stringify({
        host: { wrong: true },
        token: "config-token",
        credentialBundle: "must-not-leak",
      }),
      { mode: 0o600 },
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

    expect(await main(["list"], h.deps)).toBe(EXIT.OK);
    expect(request?.url).toBe("https://env.example/api/sessions");
    expect(request?.headers.get("authorization")).toBe("Bearer config-token");
    expect(h.stdout.join("")).not.toContain("must-not-leak");
  });

  test("init is create-only and rejects direct connection credentials", async () => {
    const home = await temporaryDirectory();
    const h = harness({ home });
    const code = await main(
      ["init", "--host", "https://worker.example/", "--token-file", "/private/token"],
      h.deps,
    );

    expect(code).toBe(EXIT.USAGE);
    expect(h.error().error.message).toBe("init does not accept --host or --token-file");
    expect(h.stdout.join("")).not.toContain("/private/token");
    expect(h.prompts()).toBe(0);
  });

  test("init rejects a legacy retry journal without a wrapping key", async () => {
    const home = await temporaryDirectory();
    await mkdir(join(home, ".scotty"), { recursive: true });
    await writeFile(
      join(home, ".scotty", "init-home.json"),
      JSON.stringify({
        operation: "init",
        phase: "apply_started",
        installationName: "home",
        profile: "default",
        accountId: "0123456789abcdef0123456789abcdef",
        stackName: "Scotty-home",
        workerName: "scotty-home-worker",
        runnerWorkerName: "scotty-home-runner",
        containerName: "scotty-home-sandbox",
        kvTitle: "scotty-home-sessions",
        backupBucketName: "scotty-home-backups",
        planFingerprint: "legacy-plan",
        token: "root-token",
      }) + "\n",
      { mode: 0o600 },
    );
    const h = harness({ home });

    expect(await main(["init", "--name", "home", ...HATCH_INIT_ARGS, "--yes"], h.deps)).toBe(
      EXIT.GENERIC,
    );
    expect(h.error().error.code).toBe("init_journal_invalid");
  });

  test("init creates a required named installation and stores a portable pointer", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    let request: Parameters<NonNullable<CliDependencies["createInstallation"]>>[0] | undefined;
    let putCount = 0;
    const commands: string[][] = [];
    let putAuthorization: string | null = null;
    let putOrigin: string | undefined;
    const h = harness({
      run: async (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      home,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/api/sandbox/configuration")
          return Response.json({ revision: 0, activeDigest: null });
        const match = url.pathname.match(/^\/api\/sandbox\/bundles\/([0-9a-f]{64})$/u);
        if (match && request.method === "PUT") {
          putCount++;
          putAuthorization = request.headers.get("authorization");
          putOrigin = url.origin;
          return Response.json({
            revision: 1,
            activeDigest: match[1],
          });
        }
        return Response.json({ error: { code: "not_found", message: "missing" } }, { status: 404 });
      },
      planCreateInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: false,
        fingerprint: "create-plan-1",
        changes: [{ id: "Scotty-home/Worker", action: "create" }],
      }),
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
          previewBase: input.previewBase,
          previewZoneId: input.previewZoneId,
          evidenceEnabled: input.evidenceEnabled,
          host: "https://scotty-home-worker.example.workers.dev/",
        };
      },
    });

    expect(
      await main(
        ["init", "--name", "home", "--profile", "personal", ...HATCH_INIT_ARGS, "--yes"],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    expect(request).not.toHaveProperty("githubToken");
    expect(request).not.toHaveProperty("piAuthJson");
    expect(request).toMatchObject({
      installationName: "home",
      profile: "personal",
      expectedAccountId: "0123456789abcdef0123456789abcdef",
      expectedPlanFingerprint: "create-plan-1",
      mode: "fresh",
      previewBase: "preview.scotty.example",
      previewZoneId: "0123456789abcdef0123456789abcdef",
      evidenceEnabled: true,
    });
    expect(request?.token).toMatch(/^[0-9a-f]{64}$/u);
    expect(request?.credentialWrappingKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(request?.credentialWrappingKey ?? "", "base64url")).toHaveLength(32);
    const config = JSON.parse(await readFile(managedInstallationPath(home), "utf8"));
    expect(commands.some(([command]) => command === "gh")).toBe(false);
    expect((await stat(managedInstallationPath(home))).mode & 0o777).toBe(0o600);
    expect(config).toEqual({
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
      previewBase: "preview.scotty.example",
      previewZoneId: "0123456789abcdef0123456789abcdef",
      evidenceEnabled: true,
      host: "https://scotty-home-worker.example.workers.dev",
      token: request?.token,
    });
    expect(h.stdout.join("")).not.toContain(request?.token ?? "impossible");
    expect(h.stdout.join("")).not.toContain(request?.credentialWrappingKey ?? "impossible");
    expect(JSON.stringify(config)).not.toContain(request?.credentialWrappingKey ?? "impossible");
    expect(h.json()).toEqual({
      configPath: managedInstallationPath(home),
      installationName: "home",
      profile: "personal",
      accountId: "0123456789abcdef0123456789abcdef",
      workerName: "scotty-home-worker",
      host: "https://scotty-home-worker.example.workers.dev",
      rootTokenRotated: true,
    });
    expect(putCount).toBe(1);
    expect(putOrigin).toBe("https://scotty-home-worker.example.workers.dev");
    expect(putAuthorization).toBe(`Bearer ${config.token}`);
    expect(config.token).not.toBe("secret");
  });

  test("init presents a bounded interactive review and progress receipt", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    let promptLabel = "";
    let createCalls = 0;
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const h = harness({
      home,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      prompt: (label) => {
        promptLabel = label;
        return "home";
      },
      fetch: acceptingSandboxSyncFetch(),
      planCreateInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: false,
        fingerprint: "interactive-plan",
        changes: [{ id: "Scotty-home/Worker", action: "create" }],
      }),
      createInstallation: async (input) => {
        createCalls++;
        await createGate;
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
          previewBase: input.previewBase,
          previewZoneId: input.previewZoneId,
          evidenceEnabled: input.evidenceEnabled,
          host: "https://scotty-home-worker.example.workers.dev",
        };
      },
    });

    const running = main(["init", "--name", "home", ...HATCH_INIT_ARGS], h.deps);
    for (let attempt = 0; attempt < 100 && createCalls === 0; attempt++) await Bun.sleep(5);
    const inFlightOutput = stripVTControlCharacters(h.stdout.join("")).replaceAll("\r", "");
    releaseCreate();

    expect(inFlightOutput).toContain("Creating Cloudflare resources");
    expect(await running).toBe(EXIT.OK);

    const output = stripVTControlCharacters(h.stdout.join("")).replaceAll("\r", "");
    expect(output).toContain("Scotty init");
    expect(output).toContain("Installation review");
    expect(output).toContain("scotty-home-worker");
    expect(output).toContain("preview.scotty.example");
    expect(output).toContain("Installation plan ready");
    expect(output).toContain("Cloudflare resources created");
    expect(output).toContain("Sandbox capabilities synchronized");
    expect(output).toContain("Run `scotty owner recover` next");
    expect(promptLabel).toBe("Create home? Type home: ");
    expect(createCalls).toBe(1);
  });

  test("init cancellation stops before resource creation", async () => {
    const home = await temporaryDirectory();
    let createCalls = 0;
    const h = harness({
      home,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      prompt: () => "no",
      planCreateInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: false,
        fingerprint: "interactive-plan",
        changes: [{ id: "Scotty-home/Worker", action: "create" }],
      }),
      createInstallation: async () => {
        createCalls++;
        nodeAssert.fail("create must not run");
      },
    });

    expect(await main(["init", "--name", "home", ...HATCH_INIT_ARGS], h.deps)).toBe(EXIT.USAGE);
    expect(h.error().error).toMatchObject({
      code: "cancelled",
      hint: "No resources were changed.",
    });
    expect(createCalls).toBe(0);
  });

  test("init synchronizes the configured TOML bundle and directs browser activation", async () => {
    const home = await temporaryDirectory();
    const skillRoot = await temporaryDirectory();
    const skillPath = join(skillRoot, "release-notes");
    await mkdir(skillPath);
    await writeFile(
      join(skillPath, "SKILL.md"),
      "---\nname: release-notes\ndescription: Draft release notes.\n---\n\n# Release notes\n",
    );
    await writeScottyToml(home, { skills: [skillRoot] });
    let uploadedDigest: string | undefined;
    const h = harness({
      home,
      stdoutIsTTY: true,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/api/sandbox/configuration")
          return Response.json({
            revision: uploadedDigest === undefined ? 0 : 1,
            activeDigest: uploadedDigest ?? null,
          });
        const match = url.pathname.match(/^\/api\/sandbox\/bundles\/([0-9a-f]{64})$/u);
        if (match && request.method === "PUT") {
          uploadedDigest = match[1];
          return Response.json({
            revision: 1,
            activeDigest: uploadedDigest,
          });
        }
        return Response.json({ error: { code: "not_found", message: "missing" } }, { status: 404 });
      },
      planCreateInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: false,
        fingerprint: "create-plan-1",
        changes: [{ id: "Scotty-home/Worker", action: "create" }],
      }),
      createInstallation: async (input) => ({
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
        previewBase: input.previewBase,
        previewZoneId: input.previewZoneId,
        evidenceEnabled: input.evidenceEnabled,
        host: "https://scotty-home-worker.example.workers.dev/",
      }),
    });

    expect(await main(["init", "--name", "home", ...HATCH_INIT_ARGS, "--yes"], h.deps)).toBe(
      EXIT.OK,
    );
    expect(h.stdout.join("")).toContain(
      "Scotty is deployed and synchronized. Browser access is not active yet.\n",
    );
    expect(h.stdout.join("")).not.toContain("Scotty init");
    expect(h.stdout.join("")).not.toContain("Checking Docker");
    expect(h.stdout.join("")).toContain("Run `scotty owner recover` next to activate it.\n");
    expect(h.stdout.join("")).not.toContain("scotty sync");
    expect(uploadedDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      await stat(join(home, ".scotty", "sandbox.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);

    let secondPutCount = 0;
    const second = harness({
      home,
      env: {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/api/sandbox/configuration")
          return Response.json({
            revision: 1,
            activeDigest: uploadedDigest,
          });
        if (url.pathname === "/api/credentials/sync") return Response.json({ credentials: [] });
        if (url.pathname.startsWith("/api/sandbox/bundles/")) secondPutCount++;
        return Response.json({ error: { code: "not_found", message: "missing" } }, { status: 404 });
      },
    });
    expect(await main(["sync"], second.deps)).toBe(EXIT.OK);
    expect(second.json().digest).toBe(uploadedDigest);
    expect(second.json().items).toEqual([{ kind: "skill", name: "release-notes" }]);
    expect(secondPutCount).toBe(0);
  });

  test("init keeps the installation pointer when TOML sync fails", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    const h = harness({
      home,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/api/sandbox/configuration")
          return Response.json(
            {
              error: {
                code: "upstream",
                message: "Sandbox configuration is unavailable",
                hint: "Retry later.",
              },
            },
            { status: 502 },
          );
        return Response.json({ error: { code: "not_found", message: "missing" } }, { status: 404 });
      },
      planCreateInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: false,
        fingerprint: "create-plan-1",
        changes: [{ id: "Scotty-home/Worker", action: "create" }],
      }),
      createInstallation: async (input) => ({
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
        previewBase: input.previewBase,
        previewZoneId: input.previewZoneId,
        evidenceEnabled: input.evidenceEnabled,
        host: "https://scotty-home-worker.example.workers.dev/",
      }),
    });

    expect(await main(["init", "--name", "home", ...HATCH_INIT_ARGS, "--yes"], h.deps)).toBe(
      EXIT.GENERIC,
    );
    expect(h.error().error.code).toBe("sandbox_bundle_upload_failed");
    expect(h.error().error.hint).toBe("Retry scotty sync.");
    const config = JSON.parse(await readFile(managedInstallationPath(home), "utf8"));
    expect(config.host).toBe("https://scotty-home-worker.example.workers.dev");
    expect(config.token).toMatch(/^[0-9a-f]{64}$/u);
    expect((await stat(managedInstallationPath(home))).mode & 0o777).toBe(0o600);
  });

  test("init keeps provider and pointer ordering when TOML is missing", async () => {
    const home = await temporaryDirectory();
    const pointerPath = managedInstallationPath(home);
    const providerCalls: string[] = [];
    const bundleRequests: string[] = [];
    const h = harness({
      home,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/sandbox/bundles/"))
          bundleRequests.push(`${request.method} ${url.pathname}`);
        return Response.json(
          { error: { code: "unexpected", message: "fetch should not run" } },
          {
            status: 500,
          },
        );
      },
      planCreateInstallation: async () => {
        providerCalls.push("plan");
        return {
          installationName: "home",
          accountId: "0123456789abcdef0123456789abcdef",
          hasExistingResources: false,
          fingerprint: "create-plan-1",
          changes: [{ id: "Scotty-home/Worker", action: "create" }],
        };
      },
      createInstallation: async (input) => {
        providerCalls.push("create");
        await expect(stat(pointerPath)).rejects.toMatchObject({ code: "ENOENT" });
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
          previewBase: input.previewBase,
          previewZoneId: input.previewZoneId,
          evidenceEnabled: input.evidenceEnabled,
          host: "https://scotty-home-worker.example.workers.dev/",
        };
      },
    });

    expect(await main(["init", "--name", "home", ...HATCH_INIT_ARGS, "--yes"], h.deps)).toBe(
      EXIT.USAGE,
    );
    expect(providerCalls).toEqual(["plan", "create"]);
    expect(bundleRequests).toEqual([]);
    const error = h.error().error;
    expect(error.code).toBe("scotty_config_invalid");
    expect(error.message).toContain("file is missing");
    expect(error.hint).toContain("Run scotty sync");
    expect(JSON.parse(await readFile(pointerPath, "utf8"))).toMatchObject({
      installationName: "home",
      host: "https://scotty-home-worker.example.workers.dev",
      token: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  test("init persists explicit preview topology without changing its public JSON contract", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    let request: Parameters<NonNullable<CliDependencies["createInstallation"]>>[0] | undefined;
    const h = harness({
      home,
      stdoutIsTTY: true,
      fetch: acceptingSandboxSyncFetch(),
      planCreateInstallation: async (input) => {
        expect(input).toMatchObject({
          previewBase: "preview.scotty.example",
          previewZoneId: "0123456789abcdef0123456789abcdef",
          evidenceEnabled: true,
        });
        return {
          installationName: "home",
          accountId: "0123456789abcdef0123456789abcdef",
          hasExistingResources: false,
          fingerprint: "preview-create-plan",
          changes: [{ id: "Scotty-home/EvidencePreviewWorkerRoute", action: "create" }],
        };
      },
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
          host: "https://scotty-home-worker.example.workers.dev",
          previewBase: input.previewBase,
          previewZoneId: input.previewZoneId,
          evidenceEnabled: input.evidenceEnabled,
        };
      },
    });

    expect(
      await main(
        [
          "init",
          "--name",
          "home",
          "--preview-base",
          "preview.scotty.example",
          "--preview-zone-id",
          "0123456789abcdef0123456789abcdef",
          "--yes",
          "--json",
        ],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    expect(request).toMatchObject({
      previewBase: "preview.scotty.example",
      previewZoneId: "0123456789abcdef0123456789abcdef",
    });
    const config = JSON.parse(await readFile(managedInstallationPath(home), "utf8"));
    expect(config).toMatchObject({
      previewBase: "preview.scotty.example",
      previewZoneId: "0123456789abcdef0123456789abcdef",
      evidenceEnabled: true,
    });
    expect(h.json()).toEqual({
      configPath: managedInstallationPath(home),
      installationName: "home",
      profile: "default",
      accountId: "0123456789abcdef0123456789abcdef",
      workerName: "scotty-home-worker",
      host: "https://scotty-home-worker.example.workers.dev",
      rootTokenRotated: true,
    });

    const invalid = harness({ home: await temporaryDirectory() });
    expect(
      await main(
        ["init", "--name", "home", "--preview-base", "preview.scotty.example", "--yes"],
        invalid.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(invalid.error().error.message).toContain("must both provide");
  });

  test("init always enables Hatch and Evidence and persists them across deploys", async () => {
    const missingPreview = harness({ home: await temporaryDirectory() });
    expect(await main(["init", "--name", "home", "--yes"], missingPreview.deps)).toBe(EXIT.USAGE);
    expect(missingPreview.error().error.message).toContain("requires --preview-base");

    const home = await temporaryDirectory();
    await writeScottyToml(home);
    const deploymentRequests: Array<
      Parameters<NonNullable<CliDependencies["deployInstallation"]>>[0]
    > = [];
    const enabledResult = {
      installationName: "home",
      profile: "default",
      stackName: "Scotty-home",
      stage: "production",
      accountId: "0123456789abcdef0123456789abcdef",
      workerName: "scotty-home-worker",
      runnerWorkerName: "scotty-home-runner",
      containerName: "scotty-home-sandbox",
      kvTitle: "scotty-home-sessions",
      backupBucketName: "scotty-home-backups",
      previewBase: "preview.scotty.example",
      previewZoneId: "0123456789abcdef0123456789abcdef",
      evidenceEnabled: true as const,
      host: "https://scotty-home-worker.example.workers.dev",
    };
    const h = harness({
      home,
      fetch: acceptingSandboxSyncFetch(),
      planCreateInstallation: async (input) => {
        expect(input.evidenceEnabled).toBe(true);
        return {
          installationName: "home",
          accountId: enabledResult.accountId,
          hasExistingResources: false,
          fingerprint: "enabled-create-plan",
          changes: [{ id: "Scotty-home/Worker", action: "create" }],
        };
      },
      createInstallation: async (input) => {
        expect(input).toMatchObject({
          previewBase: enabledResult.previewBase,
          previewZoneId: enabledResult.previewZoneId,
          evidenceEnabled: true,
        });
        return enabledResult;
      },
      planInstallation: async (input) => {
        expect(input.evidenceEnabled).toBe(true);
        return {
          installationName: "home",
          accountId: enabledResult.accountId,
          hasExistingResources: true,
          fingerprint: "enabled-deploy-plan",
          changes: [{ id: "Scotty-home/Worker", action: "update" }],
        };
      },
      deployInstallation: async (input) => {
        deploymentRequests.push(input);
        return enabledResult;
      },
    });

    expect(
      await main(
        [
          "init",
          "--name",
          "home",
          "--preview-base",
          enabledResult.previewBase,
          "--preview-zone-id",
          enabledResult.previewZoneId,
          "--yes",
        ],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    expect(JSON.parse(await readFile(managedInstallationPath(home), "utf8"))).toMatchObject({
      previewBase: enabledResult.previewBase,
      previewZoneId: enabledResult.previewZoneId,
      evidenceEnabled: true,
    });

    await planDeployment(h);
    expect(await main(["deploy", "--yes"], h.deps)).toBe(EXIT.OK);
    expect(deploymentRequests).toHaveLength(1);
    expect(deploymentRequests[0]).toMatchObject({
      previewBase: enabledResult.previewBase,
      previewZoneId: enabledResult.previewZoneId,
      evidenceEnabled: true,
    });
    expect(JSON.parse(await readFile(managedInstallationPath(home), "utf8"))).toMatchObject({
      evidenceEnabled: true,
    });
  });

  test("rejects an incomplete managed preview and evidence configuration", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      managedInstallationPath(home),
      JSON.stringify({
        installationName: "home",
        profile: "default",
        accountId: "0123456789abcdef0123456789abcdef",
        previewBase: "preview.scotty.example",
        previewZoneId: "0123456789abcdef0123456789abcdef",
        token: "root-secret",
      }),
      { mode: 0o600 },
    );
    const h = harness({ home });
    expect(await main(["deploy", "--plan"], h.deps)).toBe(EXIT.USAGE);
    expect(h.error().error.code).toBe("invalid_config");
  });

  test("init preserves an apply-started journal and refuses an automatic retry", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    const requests: Array<Parameters<NonNullable<CliDependencies["createInstallation"]>>[0]> = [];
    let plans = 0;
    const accountId = "0123456789abcdef0123456789abcdef";
    const h = harness({
      home,
      fetch: acceptingSandboxSyncFetch(),
      planCreateInstallation: async () => {
        plans += 1;
        return {
          installationName: "home",
          accountId,
          hasExistingResources: false,
          fingerprint: "create-plan",
          changes: [{ id: "Scotty-home/Worker", action: "create" }],
        };
      },
      createInstallation: async (request) => {
        requests.push(request);
        return rejected("ambiguous apply result");
      },
    });

    expect(
      await main(
        ["init", "--name", "home", "--profile", "personal", ...HATCH_INIT_ARGS, "--yes"],
        h.deps,
      ),
    ).toBe(EXIT.GENERIC);
    const journalPath = join(home, ".scotty", "init-home.json");
    const journalText = await readFile(journalPath, "utf8");
    const journal = JSON.parse(journalText);
    expect(journal.phase).toBe("apply_started");
    expect(journal.credentialWrappingKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect((await stat(journalPath)).mode & 0o777).toBe(0o600);

    let retryPlans = 0;
    let retryCreates = 0;
    const retry = harness({
      home,
      planCreateInstallation: async () => {
        retryPlans += 1;
        return Promise.reject(new Error("init must not re-plan an ambiguous installation"));
      },
      createInstallation: async () => {
        retryCreates += 1;
        return Promise.reject(new Error("init must not retry an ambiguous installation"));
      },
    });
    expect(
      await main(
        ["init", "--name", "home", "--profile", "personal", ...HATCH_INIT_ARGS],
        retry.deps,
      ),
    ).toBe(EXIT.GENERIC);
    expect(plans).toBe(1);
    expect(retryPlans).toBe(0);
    expect(retryCreates).toBe(0);
    const error = retry.error().error;
    expect(error).toMatchObject({
      code: "init_outcome_ambiguous",
      message: "The previous installation initialization has an ambiguous outcome",
    });
    expect(error.hint).toContain(`Verify Cloudflare state before removing ${journalPath}`);
    expect(error.hint).toContain("init will not retry automatically");
    expect(await readFile(journalPath, "utf8")).toBe(journalText);
    expect(requests).toHaveLength(1);
  });

  test("recover inspects, confirms, and rotates only the token", async () => {
    const home = await temporaryDirectory();
    const inspected: Array<Parameters<NonNullable<CliDependencies["inspectInstallation"]>>[0]> = [];
    const recovered: Array<Parameters<NonNullable<CliDependencies["recoverInstallation"]>>[0]> = [];
    const result = {
      installationName: "home",
      profile: "default",
      stackName: "Scotty-home",
      stage: "production",
      accountId: "0123456789abcdef0123456789abcdef",
      workerName: "scotty-home-worker",
      runnerWorkerName: "scotty-home-runner",
      containerName: "scotty-home-sandbox",
      kvTitle: "scotty-home-sessions",
      backupBucketName: "scotty-home-backups",
      host: "https://scotty-home-worker.example.workers.dev",
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
    expect(await main(["recover", "--name", "home", "--yes"], h.deps)).toBe(EXIT.OK);
    expect(inspected).toEqual([
      {
        installationName: "home",
        profile: "default",
      },
    ]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      installationName: "home",
      profile: "default",
      expectedAccountId: "0123456789abcdef0123456789abcdef",
      expectedWorkerName: "scotty-home-worker",
      expectedRunnerWorkerName: "scotty-home-runner",
      expectedContainerName: "scotty-home-sandbox",
      expectedKvTitle: "scotty-home-sessions",
      expectedBackupBucketName: "scotty-home-backups",
    });
    expect(recovered[0]?.token).toMatch(/^[0-9a-f]{64}$/u);
    const config = JSON.parse(await readFile(managedInstallationPath(home), "utf8"));
    expect(config.token).toBe(recovered[0]?.token);
    expect(h.stdout.join("")).not.toContain(config.token);
  });

  test("deploy updates code without passing or changing the root token", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    await writeFile(
      managedInstallationPath(home),
      JSON.stringify({
        ...managedConfig(),
        installationName: "home",
        profile: "personal",
        accountId: "0123456789abcdef0123456789abcdef",
        host: "https://old.example",
        token: "root-secret",
      }),
      { mode: 0o600 },
    );
    let request: Parameters<NonNullable<CliDependencies["deployInstallation"]>>[0] | undefined;
    let putAuthorization: string | null = null;
    let putOrigin: string | undefined;
    const h = harness({
      home,
      fetch: async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.pathname === "/api/sandbox/configuration")
          return Response.json({ revision: 0, activeDigest: null });
        if (url.pathname.startsWith("/api/sandbox/bundles/") && req.method === "PUT") {
          putAuthorization = req.headers.get("authorization");
          putOrigin = url.origin;
          return Response.json({
            revision: 1,
            activeDigest: url.pathname.split("/").at(-1),
          });
        }
        return Response.json({ error: { code: "not_found", message: "missing" } }, { status: 404 });
      },
      planInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
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

    await planDeployment(h);
    expect(await main(["deploy", "--yes"], h.deps)).toBe(EXIT.OK);
    expect(request).toEqual({
      installationName: "home",
      profile: "personal",
      expectedAccountId: "0123456789abcdef0123456789abcdef",
      expectedPlanFingerprint: "plan-1",
      previewBase: "preview.scotty.example",
      previewZoneId: "0123456789abcdef0123456789abcdef",
      evidenceEnabled: true,
    });
    expect(request).not.toHaveProperty("token");
    const config = JSON.parse(await readFile(managedInstallationPath(home), "utf8"));
    expect(config.token).toBe("root-secret");
    expect(config.host).toBe("https://new.example");
    expect(h.json().rootTokenRotated).toBe(false);
    expect(putOrigin).toBe("https://new.example");
    expect(putAuthorization).toBe("Bearer root-secret");
    await expect(readFile(deploymentPlanPath(home), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("deploy plan is read-only and saves the exact provider and bundle identities", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    await writeFile(managedInstallationPath(home), JSON.stringify(managedConfig()), {
      mode: 0o600,
    });
    let applied = false;
    let fetched = false;
    const h = harness({
      home,
      fetch: async () => {
        fetched = true;
        return new Response();
      },
      planInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: true,
        fingerprint: "plan-reviewed",
        changes: [{ id: "Scotty-home/Worker", action: "update" }],
      }),
      deployInstallation: async () => {
        applied = true;
        return rejected("plan must not apply");
      },
    });

    expect(await main(["deploy", "--plan"], h.deps)).toBe(EXIT.OK);
    expect(applied).toBe(false);
    expect(fetched).toBe(false);
    expect(h.json()).toMatchObject({
      installationName: "home",
      version: VERSION,
      plan: "plan-reviewed",
      bundle: expect.stringMatching(/^[0-9a-f]{64}$/u),
      changes: [{ id: "Scotty-home/Worker", action: "update" }],
    });
    const saved = JSON.parse(await readFile(deploymentPlanPath(home), "utf8"));
    expect(saved).toMatchObject({
      version: 1,
      cliVersion: VERSION,
      installationName: "home",
      accountId: "0123456789abcdef0123456789abcdef",
      planFingerprint: "plan-reviewed",
      bundleDigest: h.json().bundle,
    });
    expect((await stat(deploymentPlanPath(home))).mode & 0o777).toBe(0o600);
  });

  test("deploy yes fails closed when the reviewed bundle changes", async () => {
    const home = await temporaryDirectory();
    const skillRoot = join(home, "skills");
    const skillDirectory = join(skillRoot, "example");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), "# Before\n");
    await writeScottyToml(home, { skills: [skillRoot] });
    await writeFile(managedInstallationPath(home), JSON.stringify(managedConfig()), {
      mode: 0o600,
    });
    let applied = false;
    const h = harness({
      home,
      planInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: true,
        fingerprint: "plan-stable",
        changes: [{ id: "Scotty-home/Worker", action: "update" }],
      }),
      deployInstallation: async () => {
        applied = true;
        return rejected("changed bundle must not apply");
      },
    });

    await planDeployment(h);
    await writeFile(join(skillDirectory, "SKILL.md"), "# After\n");
    expect(await main(["deploy", "--yes"], h.deps)).toBe(EXIT.USAGE);
    expect(applied).toBe(false);
    expect(h.error().error.code).toBe("deployment_plan_changed");
    expect(await stat(deploymentPlanPath(home))).toBeDefined();
  });

  test("deploy yes requires an explicit saved plan", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    await writeFile(managedInstallationPath(home), JSON.stringify(managedConfig()), {
      mode: 0o600,
    });
    const h = harness({
      home,
      planInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: true,
        fingerprint: "plan-not-saved",
        changes: [{ id: "Scotty-home/Worker", action: "update" }],
      }),
    });

    expect(await main(["deploy", "--yes"], h.deps)).toBe(EXIT.USAGE);
    expect(h.error().error.message).toBe("deploy --yes requires a saved plan");
  });

  test("deploy plan can be consumed by only one concurrent apply", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    await writeFile(managedInstallationPath(home), JSON.stringify(managedConfig()), {
      mode: 0o600,
    });
    let applyCount = 0;
    const overrides: Partial<CliDependencies> = {
      home,
      fetch: acceptingSandboxSyncFetch(),
      planInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: true,
        fingerprint: "plan-one-use",
        changes: [{ id: "Scotty-home/Worker", action: "update" }],
      }),
      deployInstallation: async (input) => {
        applyCount += 1;
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
          host: "https://worker.example",
        };
      },
    };
    await planDeployment(harness(overrides));
    const first = harness(overrides);
    const second = harness(overrides);

    const exits = await Promise.all([
      main(["deploy", "--yes"], first.deps),
      main(["deploy", "--yes"], second.deps),
    ]);

    expect(exits.toSorted()).toEqual([EXIT.OK, EXIT.USAGE]);
    expect(applyCount).toBe(1);
    const failed = exits[0] === EXIT.USAGE ? first : second;
    expect(failed.error().error.message).toBe("deploy --yes requires a saved plan");
  });

  test("deploy keeps the rewritten pointer when TOML sync fails", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    await writeFile(
      managedInstallationPath(home),
      JSON.stringify({
        ...managedConfig(),
        installationName: "home",
        profile: "personal",
        accountId: "0123456789abcdef0123456789abcdef",
        host: "https://old.example",
        token: "root-secret",
      }),
      { mode: 0o600 },
    );
    const h = harness({
      home,
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "upstream",
              message: "Sandbox configuration is unavailable",
              hint: "Retry later.",
            },
          },
          { status: 502 },
        ),
      planInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: true,
        fingerprint: "plan-1",
        changes: [{ id: "Scotty-home/Worker", action: "update" }],
      }),
      deployInstallation: async (input) => ({
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
      }),
    });

    await planDeployment(h);
    expect(await main(["deploy", "--yes"], h.deps)).toBe(EXIT.GENERIC);
    expect(h.error().error.code).toBe("sandbox_bundle_upload_failed");
    expect(h.error().error.hint).toBe("Retry scotty sync.");
    const config = JSON.parse(await readFile(managedInstallationPath(home), "utf8"));
    expect(config.host).toBe("https://new.example");
    expect(config.token).toBe("root-secret");
  });

  test("deploy refuses provider writes when TOML is invalid", async () => {
    const home = await temporaryDirectory();
    const pointerPath = managedInstallationPath(home);
    await writeScottyToml(home);
    await writeFile(scottyTomlConfigPath(home), "version =\n", { mode: 0o600 });
    await writeFile(
      pointerPath,
      JSON.stringify({
        ...managedConfig(),
        installationName: "home",
        profile: "personal",
        accountId: "0123456789abcdef0123456789abcdef",
        host: "https://old.example",
        token: "root-secret",
      }),
      { mode: 0o600 },
    );
    const providerCalls: string[] = [];
    const bundleRequests: string[] = [];
    const h = harness({
      home,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/sandbox/bundles/"))
          bundleRequests.push(`${request.method} ${url.pathname}`);
        return Response.json(
          { error: { code: "unexpected", message: "fetch should not run" } },
          {
            status: 500,
          },
        );
      },
      planInstallation: async () => {
        providerCalls.push("plan");
        return {
          installationName: "home",
          accountId: "0123456789abcdef0123456789abcdef",
          hasExistingResources: true,
          fingerprint: "plan-1",
          changes: [{ id: "Scotty-home/Worker", action: "update" }],
        };
      },
      deployInstallation: async (input) => {
        providerCalls.push("deploy");
        expect(JSON.parse(await readFile(pointerPath, "utf8")).host).toBe("https://old.example");
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

    expect(await main(["deploy", "--plan"], h.deps)).toBe(EXIT.USAGE);
    expect(providerCalls).toEqual([]);
    expect(bundleRequests).toEqual([]);
    const error = h.error().error;
    expect(error.code).toBe("scotty_config_invalid");
    expect(error.message).toContain("TOML syntax");
    expect(error.hint).toContain("Run scotty sync");
    expect(JSON.parse(await readFile(pointerPath, "utf8"))).toMatchObject({
      host: "https://old.example",
      token: "root-secret",
    });
  });

  test("deploy skips confirmation and apply when the plan has no changes", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    await writeFile(
      managedInstallationPath(home),
      JSON.stringify({
        ...managedConfig(),
        installationName: "home",
        profile: "default",
        accountId: "0123456789abcdef0123456789abcdef",
        host: "https://worker.example",
        token: "root-secret",
      }),
      { mode: 0o600 },
    );
    let applied = false;
    let putCount = 0;
    let putAuthorization: string | null = null;
    const h = harness({
      home,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/api/sandbox/configuration")
          return Response.json({ revision: 0, activeDigest: null });
        if (url.pathname.startsWith("/api/sandbox/bundles/") && request.method === "PUT") {
          putCount++;
          putAuthorization = request.headers.get("authorization");
          return Response.json({
            revision: 1,
            activeDigest: url.pathname.split("/").at(-1),
          });
        }
        return Response.json({ error: { code: "not_found", message: "missing" } }, { status: 404 });
      },
      planInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: true,
        fingerprint: "plan-noop",
        changes: [],
      }),
      deployInstallation: async () => {
        applied = true;
        return rejected("must not apply a no-op plan");
      },
    });

    await planDeployment(h);
    expect(await main(["deploy", "--yes"], h.deps)).toBe(EXIT.OK);
    expect(applied).toBe(false);
    expect(putCount).toBe(1);
    expect(putAuthorization).toBe("Bearer root-secret");
    expect(h.json()).toEqual({
      installationName: "home",
      version: VERSION,
      plan: "plan-noop",
      bundle: expect.stringMatching(/^[0-9a-f]{64}$/u),
      changed: false,
      changes: [],
      rootTokenRotated: false,
    });
  });

  test("deploy no-change keeps the pointer and skips provider apply when TOML is missing", async () => {
    const home = await temporaryDirectory();
    const pointerPath = managedInstallationPath(home);
    const pointerText = `${JSON.stringify({
      ...managedConfig(),
      installationName: "home",
      profile: "default",
      accountId: "0123456789abcdef0123456789abcdef",
      host: "https://worker.example",
      token: "root-secret",
    })}\n`;
    await writeFile(pointerPath, pointerText, { mode: 0o600 });
    const providerCalls: string[] = [];
    const bundleRequests: string[] = [];
    const h = harness({
      home,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/sandbox/bundles/"))
          bundleRequests.push(`${request.method} ${url.pathname}`);
        return Response.json(
          { error: { code: "unexpected", message: "fetch should not run" } },
          {
            status: 500,
          },
        );
      },
      planInstallation: async () => {
        providerCalls.push("plan");
        return {
          installationName: "home",
          accountId: "0123456789abcdef0123456789abcdef",
          hasExistingResources: true,
          fingerprint: "plan-noop",
          changes: [],
        };
      },
      deployInstallation: async () => {
        providerCalls.push("deploy");
        return rejected("must not apply a no-op plan");
      },
    });

    expect(await main(["deploy", "--plan"], h.deps)).toBe(EXIT.USAGE);
    expect(providerCalls).toEqual([]);
    expect(bundleRequests).toEqual([]);
    const error = h.error().error;
    expect(error.code).toBe("scotty_config_invalid");
    expect(error.message).toContain("file is missing");
    expect(error.hint).toContain("Run scotty sync");
    expect(await readFile(pointerPath, "utf8")).toBe(pointerText);
  });

  test("deploy requires an explicit plan or apply mode", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    await writeFile(
      managedInstallationPath(home),
      JSON.stringify({
        ...managedConfig(),
        installationName: "home",
        profile: "default",
        accountId: "0123456789abcdef0123456789abcdef",
        token: "root-secret",
      }),
      { mode: 0o600 },
    );
    const h = harness({
      home,
      planInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: true,
        fingerprint: "plan-2",
        changes: [{ id: "Scotty-home/Worker", action: "update" }],
      }),
    });

    expect(await main(["deploy"], h.deps)).toBe(EXIT.USAGE);
    expect(h.error().error.message).toBe("deploy requires --plan or --yes");
  });

  test("init create failures keep the public envelope and persist a redacted diagnostic", async () => {
    const home = await temporaryDirectory();
    const secret = "ghp_syntheticInitSecretTokenValue";
    const account = "0123456789abcdef0123456789abcdef";
    let wrappingKey: string | undefined;
    const h = harness({
      home,
      env: { SCOTTY_TOKEN: secret, CLOUDFLARE_API_TOKEN: secret },
      planCreateInstallation: async () => ({
        installationName: "home",
        accountId: account,
        hasExistingResources: false,
        fingerprint: "create-plan-1",
        changes: [{ id: "Scotty-home/Worker", action: "create" }],
      }),
      createInstallation: async (input) => {
        wrappingKey = input.credentialWrappingKey;
        throw Object.assign(
          new Error(`Alchemy failed for ${account} with ${secret} and ${wrappingKey}`),
          {
            _tag: "InstallationDeploymentError",
            cause: { message: `nested ${secret} and ${wrappingKey}` },
          },
        );
      },
    });

    expect(await main(["init", "--name", "home", ...HATCH_INIT_ARGS, "--yes"], h.deps)).toBe(
      EXIT.GENERIC,
    );
    const envelope = h.error();
    expect(Object.keys(envelope)).toEqual(["error"]);
    expect(Object.keys(envelope.error).sort()).toEqual(["code", "hint", "message"]);
    expect(envelope.error).toMatchObject({
      code: "installation_create_failed",
      message: "Could not create the Scotty installation",
    });
    expect(envelope.error.hint).toMatch(
      /^Check Cloudflare authentication, Docker, and permissions, then retry scotty init\./u,
    );
    expect(envelope.error.hint).toContain(
      `Diagnostic: ${join(home, ".scotty/diagnostics/init-create.json")}`,
    );
    expect(h.stderr.join("")).not.toContain(secret);
    expect(envelope.error.hint).not.toContain(secret);
    expect(envelope).not.toHaveProperty("cause");
    expect(envelope.error).not.toHaveProperty("cause");
    expect(envelope.error).not.toHaveProperty("diagnostic");

    const diagnosticPath = join(home, ".scotty", "diagnostics", "init-create.json");
    expect((await stat(diagnosticPath)).mode & 0o777).toBe(0o600);
    const diagnostic = await readFile(diagnosticPath, "utf8");
    expect(wrappingKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect((await stat(join(home, ".scotty", "init-home.json"))).mode & 0o777).toBe(0o600);
    const journal = JSON.parse(await readFile(join(home, ".scotty", "init-home.json"), "utf8"));
    expect(journal.credentialWrappingKey).toBe(wrappingKey);
    expect(diagnostic).not.toContain(wrappingKey ?? "impossible");
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain(account);
    expect(diagnostic).toContain("[redacted-secret]");
    expect(diagnostic).toContain("[redacted-account-id]");
    expect(diagnostic).toContain('"operation": "init"');
    expect(diagnostic).toContain('"phase": "create"');
    expect(diagnostic).toContain('"installationName": "home"');
    expect(diagnostic).toContain("Alchemy failed");
    expect(diagnostic).toContain("nested");
  });

  test("deployment without the Registry wrapping key requires a fresh installation", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    await writeFile(
      managedInstallationPath(home),
      JSON.stringify({
        ...managedConfig(),
        installationName: "home",
        profile: "personal",
        accountId: "0123456789abcdef0123456789abcdef",
        host: "https://old.example",
        token: "root-secret",
      }),
      { mode: 0o600 },
    );
    const h = harness({
      home,
      planInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: true,
        fingerprint: "plan-1",
        changes: [{ id: "Scotty-home/Worker", action: "update" }],
      }),
      deployInstallation: async () => {
        throw {
          _tag: "InstallationDeploymentError",
          cause: {
            _tag: "CredentialWrappingKeyUnavailable",
            message: "The installation has no CREDENTIAL_WRAPPING_KEY binding.",
          },
        };
      },
    });

    await planDeployment(h);
    expect(await main(["deploy", "--yes"], h.deps)).toBe(EXIT.GENERIC);
    expect(h.error()).toEqual({
      error: {
        code: "installation_fresh_required",
        message: "This installation is missing the Credential Registry wrapping key",
        hint: "Create a fresh Scotty installation before deploying or recovering Registry-backed code; existing sessions are unsupported and are not migrated.",
      },
    });
  });

  test("no-op deploy refuses to synchronize before the wrapping-key preflight", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    await writeFile(
      managedInstallationPath(home),
      JSON.stringify({
        ...managedConfig(),
        installationName: "home",
        profile: "default",
        accountId: "0123456789abcdef0123456789abcdef",
        host: "https://worker.example",
        token: "root-secret",
      }),
      { mode: 0o600 },
    );
    let synchronized = false;
    const h = harness({
      home,
      planInstallation: async () => {
        throw {
          _tag: "CredentialWrappingKeyUnavailable",
          message: "missing",
        };
      },
      fetch: async () => {
        synchronized = true;
        return Response.json(
          { error: { code: "unexpected", message: "must not sync" } },
          { status: 500 },
        );
      },
    });

    expect(await main(["deploy", "--plan"], h.deps)).toBe(EXIT.GENERIC);
    expect(h.error().error.code).toBe("installation_fresh_required");
    expect(synchronized).toBe(false);
  });

  test("recover refuses to rotate access when the wrapping-key preflight is missing", async () => {
    const h = harness({
      home: await temporaryDirectory(),
      inspectInstallation: async () => {
        throw {
          _tag: "CredentialWrappingKeyUnavailable",
          message: "missing",
        };
      },
      recoverInstallation: async () => rejected("must not recover"),
    });

    expect(await main(["recover", "--name", "home", "--yes"], h.deps)).toBe(EXIT.GENERIC);
    expect(h.error().error).toEqual({
      code: "installation_fresh_required",
      message: "This installation is missing the Credential Registry wrapping key",
      hint: "Create a fresh Scotty installation before deploying or recovering Registry-backed code; existing sessions are unsupported and are not migrated.",
    });
  });

  test("deploy apply failures keep the public envelope and persist a redacted diagnostic", async () => {
    const home = await temporaryDirectory();
    await writeScottyToml(home);
    const secret = "synthetic-deploy-environment-secret";
    await writeFile(
      managedInstallationPath(home),
      JSON.stringify({
        ...managedConfig(),
        installationName: "home",
        profile: "personal",
        accountId: "0123456789abcdef0123456789abcdef",
        host: "https://old.example",
        token: "root-secret",
      }),
      { mode: 0o600 },
    );
    const h = harness({
      home,
      env: { SCOTTY_TOKEN: secret, CLOUDFLARE_API_TOKEN: secret },
      planInstallation: async () => ({
        installationName: "home",
        accountId: "0123456789abcdef0123456789abcdef",
        hasExistingResources: true,
        fingerprint: "plan-1",
        changes: [{ id: "Scotty-home/Worker", action: "update" }],
      }),
      deployInstallation: async () => {
        throw Object.assign(new Error(`image push failed ${secret}`), {
          _tag: "InstallationDeploymentError",
          cause: { message: `authorization: Bearer ${secret}` },
        });
      },
    });

    await planDeployment(h);
    expect(await main(["deploy", "--yes"], h.deps)).toBe(EXIT.GENERIC);
    const envelope = h.error();
    expect(Object.keys(envelope)).toEqual(["error"]);
    expect(Object.keys(envelope.error).sort()).toEqual(["code", "hint", "message"]);
    expect(envelope.error).toMatchObject({
      code: "installation_deploy_failed",
      message: "Could not deploy the Scotty installation",
    });
    expect(envelope.error.hint).toMatch(
      /^Check Cloudflare authentication and Docker, then retry scotty deploy\./u,
    );
    expect(envelope.error.hint).toContain(
      `Diagnostic: ${join(home, ".scotty/diagnostics/deploy-apply.json")}`,
    );
    expect(h.stderr.join("")).not.toContain(secret);

    const diagnosticPath = join(home, ".scotty", "diagnostics", "deploy-apply.json");
    expect((await stat(diagnosticPath)).mode & 0o777).toBe(0o600);
    const diagnostic = await readFile(diagnosticPath, "utf8");
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).toContain("[redacted-secret]");
    expect(diagnostic).toContain('"operation": "deploy"');
    expect(diagnostic).toContain('"phase": "apply"');
    expect(diagnostic).toContain("image push failed");
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
    const configPath = managedInstallationPath(home);
    await writeFile(
      configPath,
      JSON.stringify({
        ...managedConfig(),
        installationName: "home",
        profile: "personal",
        accountId: "0123456789abcdef0123456789abcdef",
        host: "https://worker.example",
        token: "root-secret",
      }),
      { mode: 0o600 },
    );
    let request: Parameters<NonNullable<CliDependencies["uninstallInstallation"]>>[0] | undefined;
    const h = harness({
      home,
      uninstallInstallation: async (input) => {
        request = input;
        return {
          installationName: input.installationName,
          deletedCompute: ["scotty-home-sandbox", "scotty-home-runner", "scotty-home-worker"],
          retainedData: ["scotty-home-sessions", "scotty-home-backups", "scotty-home-artifacts"],
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
      previewBase: "preview.scotty.example",
      previewZoneId: "0123456789abcdef0123456789abcdef",
      evidenceEnabled: true,
      expectedPreviewBase: "preview.scotty.example",
      expectedPreviewZoneId: "0123456789abcdef0123456789abcdef",
    });
    expect(await Bun.file(configPath).exists()).toBe(false);
    expect(h.json()).toEqual({
      installationName: "home",
      deletedCompute: ["scotty-home-sandbox", "scotty-home-runner", "scotty-home-worker"],
      retainedData: ["scotty-home-sessions", "scotty-home-backups", "scotty-home-artifacts"],
      deletedData: [],
      configRemoved: true,
    });
  });

  test("uninstall reports manual preview cleanup and retains config without ownership proof", async () => {
    const home = await temporaryDirectory();
    const configPath = managedInstallationPath(home);
    await writeFile(
      configPath,
      JSON.stringify({
        ...managedConfig(),
        installationName: "home",
        profile: "default",
        accountId: "0123456789abcdef0123456789abcdef",
        previewBase: "preview.scotty.example",
        previewZoneId: "0123456789abcdef0123456789abcdef",
      }),
      { mode: 0o600 },
    );
    const h = harness({
      home,
      uninstallInstallation: async () => {
        throw new PreviewCleanupOwnershipError({
          message: "Alchemy state does not prove preview ownership",
          hint: "Verify ownership and clean up the wildcard resources manually.",
        });
      },
    });

    expect(await main(["uninstall", "--yes"], h.deps)).toBe(EXIT.GENERIC);
    expect(h.error()).toEqual({
      error: {
        code: "preview_cleanup_manual",
        message: "Alchemy state does not prove preview ownership",
        hint: "Verify ownership and clean up the wildcard resources manually.",
      },
    });
    expect(await Bun.file(configPath).exists()).toBe(true);
    expect(await Bun.file(join(home, ".scotty/diagnostics/uninstall-apply.json")).exists()).toBe(
      false,
    );
  });

  test("uninstall host failures keep the public envelope and persist prototype error details", async () => {
    const home = await temporaryDirectory();
    const configPath = managedInstallationPath(home);
    const secret = "synthetic-uninstall-secret-token";
    await writeFile(
      configPath,
      JSON.stringify({
        ...managedConfig(),
        installationName: "clean-room",
        profile: "clean-room",
        accountId: "0123456789abcdef0123456789abcdef",
      }),
      { mode: 0o600 },
    );

    class PrototypeHostError extends Error {
      readonly cause: unknown;

      constructor(cause: unknown) {
        super();
        this.cause = cause;
      }
    }
    Object.defineProperty(PrototypeHostError.prototype, "message", {
      value: `deployment apply failed with token ${secret}`,
      configurable: true,
    });

    const h = harness({
      home,
      env: { CLOUDFLARE_API_TOKEN: secret },
      uninstallInstallation: async () => {
        throw new PrototypeHostError(
          new AuthError({
            message: `No credentials configured for 'cloudflare'; non-interactive ${secret}`,
          }),
        );
      },
    });

    expect(await main(["uninstall", "--yes", "--json"], h.deps)).toBe(EXIT.GENERIC);
    const envelope = h.error();
    expect(Object.keys(envelope)).toEqual(["error"]);
    expect(Object.keys(envelope.error).sort()).toEqual(["code", "hint", "message"]);
    expect(envelope.error).toMatchObject({
      code: "installation_uninstall_failed",
      message: "Could not fully uninstall the Scotty installation",
    });
    expect(envelope.error.hint).toMatch(
      /^Inspect Cloudflare resources, then rerun scotty uninstall with the same options\./u,
    );
    expect(envelope.error.hint).toContain(
      `Diagnostic: ${join(home, ".scotty/diagnostics/uninstall-apply.json")}`,
    );
    expect(envelope.error).not.toHaveProperty("cause");
    expect(envelope.error).not.toHaveProperty("diagnostic");
    expect(h.stderr.join("")).not.toContain(secret);
    expect(await Bun.file(configPath).exists()).toBe(true);

    const diagnosticPath = join(home, ".scotty", "diagnostics", "uninstall-apply.json");
    expect((await stat(diagnosticPath)).mode & 0o777).toBe(0o600);
    const diagnosticText = await readFile(diagnosticPath, "utf8");
    expect(diagnosticText).not.toContain(secret);
    expect(diagnosticText).toContain("[redacted-secret]");
    expect(JSON.parse(diagnosticText)).toMatchObject({
      operation: "uninstall",
      phase: "apply",
      context: { installationName: "clean-room", profile: "clean-room" },
      cause: {
        name: "Error",
        message: "deployment apply failed with token [redacted-secret]",
        cause: {
          name: "AuthError",
          message: "No credentials configured for 'cloudflare'; non-interactive [redacted-secret]",
        },
      },
    });
  });

  test("uninstall passes the explicit data deletion choice", async () => {
    const home = await temporaryDirectory();
    await writeFile(
      managedInstallationPath(home),
      JSON.stringify({
        ...managedConfig(),
        installationName: "home",
        profile: "default",
        accountId: "0123456789abcdef0123456789abcdef",
      }),
      { mode: 0o600 },
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
          deletedData: ["scotty-home-sessions", "scotty-home-backups", "scotty-home-artifacts"],
        };
      },
    });

    expect(await main(["uninstall", "--delete-data", "--yes"], h.deps)).toBe(EXIT.OK);
    expect(deleteData).toBe(true);
    expect(h.json().deletedData).toEqual([
      "scotty-home-sessions",
      "scotty-home-backups",
      "scotty-home-artifacts",
    ]);
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
      managedInstallationPath(home),
      JSON.stringify({
        ...managedConfig(),
        installationName: "home",
        profile: "personal",
        accountId: "0123456789abcdef0123456789abcdef",
        workerName: "scotty-home-worker",
        host: "https://worker.example",
        token: "root-secret",
      }),
      { mode: 0o600 },
    );
    let authorization: string | null = null;
    const h = harness({
      home,
      env: {},
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
        return rejected("socket exploded with secret details");
      },
    });
    expect(await main(["list", "--host", "https://worker.example"], network.deps)).toBe(
      EXIT.GENERIC,
    );
    expect(network.error()).toEqual({
      error: {
        code: "network_error",
        message: "Could not reach the Scotty Worker",
        hint: "Check --host and your network, then retry.",
      },
    });

    const malformed = harness({ fetch: async () => new Response("not json", { status: 200 }) });
    expect(await main(["list", "--host", "https://worker.example"], malformed.deps)).toBe(
      EXIT.GENERIC,
    );
    expect(malformed.error().error.code).toBe("invalid_response");

    const malformedFailure = harness({
      fetch: async () => new Response("not json", { status: 502 }),
    });
    expect(await main(["list", "--host", "https://worker.example"], malformedFailure.deps)).toBe(
      EXIT.GENERIC,
    );
    expect(malformedFailure.error()).toEqual({
      error: {
        code: "http_502",
        message: "Request failed with HTTP 502",
        hint: "Check the session state and Worker logs.",
      },
    });
  });

  test("list exposes only the stable public projection", async () => {
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
      sandboxBundle: { digest: null },
      ageSeconds: 60,
      capRemainingSeconds: 14340,
      operation: { kind: "snapshot", nonce: "internal" },
      backup: { current: "must-not-leak" },
      webToken: "must-not-leak",
    };
    const h = harness({ fetch: async () => Response.json([session]) });
    expect(await main(["list", "--host", "https://worker.example"], h.deps)).toBe(EXIT.OK);
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
        sandboxBundle: { digest: null },
      },
    ]);
    expect(h.stdout.join("")).not.toContain("must-not-leak");
  });

  test("list omits invalid optionals and applies failure defaults field by field", async () => {
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
      sandboxBundle: { digest: null },
      secret: "must-not-leak",
    };
    const h = harness({ fetch: async () => Response.json([session]) });

    expect(await main(["list", "--host", "https://worker.example"], h.deps)).toBe(EXIT.OK);
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
        sandboxBundle: { digest: null },
      },
    ]);
    expect(h.stdout.join("")).not.toContain("must-not-leak");
  });
});

describe("Credential sync commands", () => {
  test("resolves every declared Pi and GitHub credential before one sync request", async () => {
    const home = await temporaryDirectory();
    const source = join(home, "pi-auth.json");
    await writeFile(
      source,
      JSON.stringify({
        openai: { type: "api_key", key: "$OPENAI_TEST_KEY" },
        "openai-codex": { type: "oauth", access: "access", refresh: "refresh", expires: 0 },
      }),
      { mode: 0o600 },
    );
    await mkdir(join(home, ".config", "scotty"), { recursive: true });
    await writeFile(
      scottyTomlConfigPath(home),
      [
        "version = 1",
        "[sync]",
        "skills = []",
        "packages = []",
        "tools = []",
        "extensions = []",
        "[repos]",
        'allowed = ["owner/project"]',
        "[credentials.openai]",
        'kind = "pi-auth"',
        `source = ${JSON.stringify(source)}`,
        'scope = "global"',
        "[credentials.github]",
        'kind = "github-cli"',
        'scope = "repository"',
        'repositories = ["owner/project"]',
      ].join("\n"),
      { mode: 0o600 },
    );
    const requests: Request[] = [];
    const h = harness({
      home,
      env: {
        OPENAI_TEST_KEY: "openai-secret",
        SCOTTY_HOST: "https://worker.example",
        SCOTTY_TOKEN: "worker-token",
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/credentials/sync") return Response.json({ credentials: [] });
        if (
          pathname === "/api/sandbox/configuration" ||
          pathname.startsWith("/api/sandbox/bundles/")
        )
          return Response.json({
            revision: 0,
            activeDigest:
              pathname === "/api/sandbox/configuration" ? null : pathname.split("/").pop(),
          });
        return Response.json({ error: { code: "not_found", message: "missing" } }, { status: 404 });
      },
    });
    expect(await main(["sync"], h.deps)).toBe(EXIT.OK);
    const credentialRequest = requests.find(
      (request) => new URL(request.url).pathname === "/api/credentials/sync",
    );
    expect(credentialRequest).toBeDefined();
    nodeAssert(credentialRequest !== undefined, "credential sync request missing");
    const credentialBody = JSON.parse(await credentialRequest.text());
    expect(credentialBody.credentials).toHaveLength(2);
    const openAiCredential = credentialBody.credentials.find(
      (credential: { name: string; kind: string }) =>
        credential.name === "openai" && credential.kind === "pi-auth",
    );
    expect(openAiCredential).toMatchObject({
      kind: "pi-auth",
      providers: { openai: { key: "openai-secret" } },
    });
    const githubCredential = credentialBody.credentials.find(
      (credential: { name: string; kind: string }) =>
        credential.name === "github" && credential.kind === "github-cli",
    );
    expect(githubCredential).toMatchObject({
      kind: "github-cli",
      token: expect.any(String),
    });
    expect(JSON.stringify(h.json())).toMatch(/^\{"digest":"[0-9a-f]{64}","items":\[\]\}$/u);
    expect(h.stderr.join("")).not.toContain("openai-secret");
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
      expect(await main(["resume", "s1", "--host", "https://worker.example"], h.deps)).toBe(exit);
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
      expect(await main(["resume", "s1", "--host", "https://worker.example"], h.deps)).toBe(exit);
      expect(h.error().error.code).toBe(expected);
      expect(h.stdout.join("")).toBe("");
    }

    const secret = "server-echoed-token";
    const redacted = harness({
      env: { SCOTTY_TOKEN: secret },
      fetch: async () =>
        Response.json(
          { error: { code: "custom", message: `failed ${secret}`, hint: `remove ${secret}` } },
          { status: 500 },
        ),
    });
    expect(await main(["resume", "s1", "--host", "https://worker.example"], redacted.deps)).toBe(
      EXIT.GENERIC,
    );
    expect(redacted.stderr.join("")).not.toContain(secret);
    expect(redacted.error().error).toEqual({
      code: "custom",
      message: "failed [REDACTED]",
      hint: "remove [REDACTED]",
    });

    const redactedCode = harness({
      env: { SCOTTY_TOKEN: secret },
      fetch: async () =>
        Response.json({ error: { code: secret, message: "failed", hint: "act" } }, { status: 500 }),
    });
    expect(
      await main(["resume", "s1", "--host", "https://worker.example"], redactedCode.deps),
    ).toBe(EXIT.GENERIC);
    expect(redactedCode.stderr.join("")).not.toContain(secret);
    expect(redactedCode.error().error.code).toBe("[REDACTED]");
  });

  test("inspect emits stable bounded JSON and human summaries from the passive snapshot", async () => {
    const snapshot = {
      epoch: "epoch-1",
      baseSequence: 5,
      sequence: 5,
      sessionRevision: 7,
      state: { isStreaming: false },
      messages: [
        { role: "user", content: "fix it" },
        { role: "assistant", content: "working" },
      ],
      overlapEvents: [],
      activeTools: [{ id: "tool-1", name: "bash", status: "running" }],
      queue: {
        steer: [{ id: "steer-1", text: "check tests" }],
        followUp: [{ id: "follow-1", text: "summarize" }],
      },
      pendingUi: [],
      pendingUiAuthority: {
        status: "partial",
        reason: "pi_0_83_signal_cancellation_unobservable",
      },
      extensionSurface: { statuses: {}, widgets: [] },
      capabilities: { models: [], thinkingLevels: [], commands: [] },
      truncated: { messages: false, values: true },
    } as const;
    const requests: Request[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json({ ...snapshot, ignored: true });
    };

    const json = harness({ fetch, stdoutIsTTY: true });
    expect(
      await main(["inspect", "s1", "--json", "--host", "https://worker.example"], json.deps),
    ).toBe(EXIT.OK);
    expect(json.json()).toEqual({ id: "s1", ...snapshot });

    const human = harness({ fetch, stdoutIsTTY: true });
    expect(await main(["inspect", "s1", "--host", "https://worker.example"], human.deps)).toBe(
      EXIT.OK,
    );
    expect(human.stdout.join("")).toBe(
      "Session s1\n" +
        "Epoch: epoch-1\n" +
        "Sequence: 5 (base 5)\n" +
        "Revision: 7\n" +
        "Messages: 2\n" +
        "Active tools: 1\n" +
        "Queued: 2\n" +
        "Pending UI: 0\n" +
        "Truncated: yes\n",
    );
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
    expect(requests.every((request) => request.cache === "no-store")).toBe(true);
    expect(
      requests.map((request) => ({
        authorization: request.headers.get("authorization"),
        method: request.method,
        pathname: new URL(request.url).pathname,
      })),
    ).toEqual([
      {
        authorization: "Bearer secret",
        method: "GET",
        pathname: "/api/sessions/s1/inspect",
      },
      {
        authorization: "Bearer secret",
        method: "GET",
        pathname: "/api/sessions/s1/inspect",
      },
    ]);
  });

  test("read selects recent user and assistant text with stable cursors and output", async () => {
    const snapshot = {
      epoch: "epoch-1",
      baseSequence: 5,
      sequence: 5,
      sessionRevision: 7,
      state: { isStreaming: false },
      messages: [
        { id: "u1", role: "user", content: "fix it" },
        {
          id: "a1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "text", text: "working" },
          ],
        },
        { id: "t1", role: "toolResult", content: "secret tool output" },
        { id: "u2", role: "user", content: [{ type: "text", text: "status?" }] },
      ],
      overlapEvents: [],
      activeTools: [],
      queue: { steer: [], followUp: [] },
      pendingUi: [],
      pendingUiAuthority: {
        status: "partial",
        reason: "pi_0_83_signal_cancellation_unobservable",
      },
      extensionSurface: { statuses: {}, widgets: [] },
      capabilities: { models: [], thinkingLevels: [], commands: [] },
      truncated: { messages: true, values: false },
    } as const;
    const requests: Request[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json(snapshot);
    };

    const latest = harness({ fetch, stdoutIsTTY: true });
    expect(
      await main(["read", "s1", "--json", "--host", "https://worker.example"], latest.deps),
    ).toBe(EXIT.OK);
    expect(latest.json()).toEqual({
      id: "s1",
      epoch: "epoch-1",
      sequence: 5,
      messages: [{ index: 3, id: "u2", role: "user", content: "status?" }],
      truncated: true,
    });

    const assistant = harness({ fetch, stdoutIsTTY: true });
    expect(
      await main(
        ["read", "s1", "--last", "2", "--role", "assistant", "--host", "https://worker.example"],
        assistant.deps,
      ),
    ).toBe(EXIT.OK);
    expect(assistant.stdout.join("")).toBe("[assistant] sequence=5 truncated=yes\nworking\n");

    const unchanged = harness({ fetch, stdoutIsTTY: true });
    expect(
      await main(
        ["read", "s1", "--since", "5", "--json", "--host", "https://worker.example"],
        unchanged.deps,
      ),
    ).toBe(EXIT.OK);
    expect(unchanged.json()).toEqual({
      id: "s1",
      epoch: "epoch-1",
      sequence: 5,
      messages: [],
      truncated: true,
    });
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.every((request) => request.cache === "no-store")).toBe(true);
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
  });

  test("read rejects invalid bounds and roles before fetching", async () => {
    let calls = 0;
    const h = harness({
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    });
    for (const args of [
      ["read", "s1", "--last", "0"],
      ["read", "s1", "--last", "501"],
      ["read", "s1", "--since", "-1"],
      ["read", "s1", "--role", "tool"],
      ["read", "s1", "extra"],
    ])
      expect(await main([...args, "--host", "https://worker.example"], h.deps)).toBe(EXIT.USAGE);
    expect(calls).toBe(0);
  });

  test("sandbox inspect and steer use only the exact internal peer-control transport", async () => {
    const home = await temporaryDirectory();
    await mkdir(managedInstallationPath(home));
    const sourceMarker = "source-session-must-not-leave-the-container";
    const requests: Request[] = [];
    const snapshot = {
      epoch: "epoch-1",
      baseSequence: 1,
      sequence: 1,
      sessionRevision: 2,
      state: { isStreaming: false },
      messages: [],
      overlapEvents: [],
      activeTools: [],
      queue: { steer: [], followUp: [] },
      pendingUi: [],
      pendingUiAuthority: {
        status: "partial",
        reason: "pi_0_83_signal_cancellation_unobservable",
      },
      extensionSurface: { statuses: {}, widgets: [] },
      capabilities: { models: [], thinkingLevels: [], commands: [] },
      truncated: { messages: false, values: false },
    } as const;
    const accepted = {
      id: "peer-1",
      status: "accepted",
      commandId: "123e4567-e89b-42d3-a456-426614174000",
      epoch: "epoch-1",
      sessionRevision: 2,
    } as const;
    const h = harness({
      home,
      env: {
        SCOTTY_SESSION_ID: sourceMarker,
        SCOTTY_HOST: "https://must-not-be-used.example",
        SCOTTY_TOKEN: "must-not-be-sent",
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return request.method === "GET" ? Response.json(snapshot) : Response.json(accepted);
      },
    });
    const ignoredOptions = [
      "--host",
      "https://also-must-not-be-used.example",
      "--token-file",
      join(home, "missing-token"),
      "--json",
    ];

    expect(await main(["inspect", "peer-1", ...ignoredOptions], h.deps)).toBe(EXIT.OK);
    expect(await main(["read", "peer-1", ...ignoredOptions], h.deps)).toBe(EXIT.OK);
    expect(await main(["steer", "peer-1", "continue", ...ignoredOptions], h.deps)).toBe(EXIT.OK);

    expect(requests.map((request) => request.url)).toEqual([
      "https://scotty.internal/api/sessions/peer-1/inspect",
      "https://scotty.internal/api/sessions/peer-1/inspect",
      "https://scotty.internal/api/sessions/peer-1/steer",
    ]);
    for (const request of requests) {
      expect(request.redirect).toBe("manual");
      expect(request.cache).toBe("no-store");
      expect(new URL(request.url).search).toBe("");
      for (const header of [
        "authorization",
        "cookie",
        "proxy-authorization",
        "x-api-key",
        "x-auth-token",
        "scotty-session-id",
        "session-id",
        "source-session-id",
        "x-session-id",
        "x-source-session-id",
      ]) {
        expect(request.headers.has(header)).toBe(false);
      }
      expect([...request.headers.keys()].some((name) => name.startsWith("x-scotty-"))).toBe(false);
      expect([...request.headers].map((entry) => entry.join(":")).join("\n")).not.toContain(
        sourceMarker,
      );
    }
    expect(requests[0]?.body).toBeNull();
    expect(requests[1]?.body).toBeNull();
    expect(await requests[2]?.json()).toEqual({ message: "continue" });
  });

  test("sandbox peer-control preserves invalid and Worker error exits", async () => {
    const invalid = harness({
      env: { SCOTTY_SESSION_ID: "source" },
      fetch: async () => Response.json({}),
    });
    expect(await main(["inspect", "peer-1", "--json"], invalid.deps)).toBe(EXIT.GENERIC);
    expect(invalid.error().error.code).toBe("invalid_response");

    const missing = harness({
      env: { SCOTTY_SESSION_ID: "source" },
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "not_found",
              message: "Session not found",
              hint: "Check the target session ID.",
            },
          },
          { status: 404 },
        ),
    });
    expect(await main(["inspect", "peer-1", "--json"], missing.deps)).toBe(EXIT.NOT_FOUND);
    expect(missing.error()).toEqual({
      error: {
        code: "not_found",
        message: "Session not found",
        hint: "Check the target session ID.",
      },
    });
  });

  test("steer emits stable accepted JSON and human output using one authenticated mutation", async () => {
    const accepted = {
      id: "s1",
      status: "accepted",
      commandId: "123e4567-e89b-42d3-a456-426614174000",
      epoch: "epoch-1",
      sessionRevision: 7,
    } as const;
    const requests: Request[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json(accepted);
    };

    const json = harness({ fetch, stdoutIsTTY: true });
    expect(
      await main(
        ["steer", "s1", "check the tests", "--json", "--host", "https://worker.example"],
        json.deps,
      ),
    ).toBe(EXIT.OK);
    expect(json.json()).toEqual(accepted);

    const human = harness({ fetch, stdoutIsTTY: true });
    expect(
      await main(
        ["steer", "s1", "check the tests", "--host", "https://worker.example"],
        human.deps,
      ),
    ).toBe(EXIT.OK);
    expect(human.stdout.join("")).toBe("Steer accepted for s1 at revision 7.\n");
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
    expect(requests.every((request) => request.cache === "no-store")).toBe(true);
    expect(
      await Promise.all(
        requests.map(async (request) => ({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
          method: request.method,
          pathname: new URL(request.url).pathname,
        })),
      ),
    ).toEqual([
      {
        authorization: "Bearer secret",
        body: { message: "check the tests" },
        method: "POST",
        pathname: "/api/sessions/s1/steer",
      },
      {
        authorization: "Bearer secret",
        body: { message: "check the tests" },
        method: "POST",
        pathname: "/api/sessions/s1/steer",
      },
    ]);
  });

  test("steer surfaces stale, unavailable, and ambiguous outcomes once with bounded output", async () => {
    for (const [reply, exitCode, humanOutput] of [
      [
        {
          id: "s1",
          status: "stale",
          reason: "session_revision_changed",
          expectedSessionRevision: 7,
          sessionRevision: 8,
          retryable: false,
        },
        EXIT.WRONG_STATE,
        "Steer was stale for s1; no command was retried.\n",
      ],
      [
        {
          id: "s1",
          status: "unavailable",
          reason: "session_not_warm",
          retryable: false,
        },
        EXIT.WRONG_STATE,
        "Steer unavailable for s1: session_not_warm.\n",
      ],
      [
        { id: "s1", status: "ambiguous", reason: "command_transport_failed" },
        EXIT.GENERIC,
        "Steer outcome is ambiguous for s1: command_transport_failed; do not retry automatically.\n",
      ],
    ] as const) {
      let calls = 0;
      const human = harness({
        stdoutIsTTY: true,
        fetch: async () => {
          calls++;
          return Response.json(reply);
        },
      });
      expect(
        await main(["steer", "s1", "continue", "--host", "https://worker.example"], human.deps),
      ).toBe(exitCode);
      expect(human.stdout.join("")).toBe(humanOutput);
      expect(calls).toBe(1);

      const json = harness({
        stdoutIsTTY: true,
        fetch: async () => Response.json(reply),
      });
      expect(
        await main(
          ["steer", "s1", "continue", "--json", "--host", "https://worker.example"],
          json.deps,
        ),
      ).toBe(exitCode);
      expect(json.json()).toEqual(reply);
    }
  });

  test("steer rejects empty, slash-command, oversized, and trailing input before fetching", async () => {
    let calls = 0;
    const h = harness({
      fetch: async () => {
        calls++;
        return Response.json({});
      },
    });
    for (const args of [
      ["steer", "s1", "  "],
      ["steer", "s1", "/help"],
      ["steer", "s1", "é".repeat(8_193)],
      ["steer", "s1", "continue", "extra"],
    ]) {
      expect(await main([...args, "--host", "https://worker.example"], h.deps)).toBe(EXIT.USAGE);
    }
    expect(calls).toBe(0);
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
      expect(await main([...args, "--host", "https://worker.example"], h.deps)).toBe(EXIT.OK);
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
      expect(await main([...args, "--host", "https://worker.example"], h.deps)).toBe(EXIT.OK);
      expect(h.json()).toEqual(expected);
    }
  });

  test("removed commands and top-level lifecycle aliases fail as unknown commands", async () => {
    for (const command of ["pr", "publish", "up", "down", "ls", "skills", "tui"]) {
      const h = harness();
      expect(await main([command, "s1"], h.deps)).toBe(EXIT.USAGE);
      expect(h.error().error.code).toBe("bad_usage");
      expect(h.stderr.join("")).toContain(`Unknown command: ${command}`);
    }
  });

  test("removed tools commands fail as bad_usage unknown commands", async () => {
    for (const args of [["tools"], ["tools", "list"], ["tools", "doctor"]] as const) {
      const h = harness();
      expect(await main(args, h.deps)).toBe(EXIT.USAGE);
      expect(h.error().error).toMatchObject({
        code: "bad_usage",
        message: "Unknown command: tools",
      });
      expect(h.stdout.join("")).toBe("");
    }
  });

  test("beam is a leaf, rejects old nested commands, and requires title, repository, and provider", async () => {
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
        ],
        removed.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(removed.error().error.message).toBe("Unknown command: up");

    for (const args of [
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
      ],
      [
        "beam",
        "down",
        "s1",
        "--title",
        "Fix build",
        "--repo",
        "owner/project",
        "--provider",
        "cloudflare",
        "--detach",
      ],
      [
        "beam",
        "vaporize",
        "s1",
        "--title",
        "Fix build",
        "--repo",
        "owner/project",
        "--provider",
        "cloudflare",
        "--detach",
      ],
    ] as const) {
      let calls = 0;
      const nested = harness({
        fetch: async () => {
          calls += 1;
          return Response.json({});
        },
      });
      expect(await main([...args, "--host", "https://worker.example"], nested.deps)).toBe(
        EXIT.USAGE,
      );
      expect(nested.error().error.code).toBe("bad_usage");
      expect(nested.error().error.message).toBe(`Unexpected argument: ${args[2]}`);
      expect(calls).toBe(0);
    }

    const missingTitle = harness();
    expect(
      await main(
        [
          "beam",
          "fix",
          "--repo",
          "owner/project",
          "--provider",
          "cloudflare",
          "--detach",
          "--host",
          "https://worker.example",
        ],
        missingTitle.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(missingTitle.error().error.message).toContain("--title");

    const h = harness();
    expect(
      await main(
        ["beam", "fix", "--title", "Fix build", "--detach", "--host", "https://worker.example"],
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
          "fix",
          "--title",
          "Fix build",
          "--repo",
          "owner/project",
          "--detach",
          "--host",
          "https://worker.example",
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
        ],
        unsupportedProvider.deps,
      ),
    ).toBe(EXIT.USAGE);
    expect(unsupportedProvider.error().error.message).toBe("--provider must be cloudflare");
  });

  test("beam strips same-origin tokens and rejects cross-origin session URLs", async () => {
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
    expect(await main(["vaporize", "s1", "--host", "https://worker.example"], h.deps)).toBe(
      EXIT.OK,
    );
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
        await main(["vaporize", "s1", "--yes", "--host", "https://worker.example"], h.deps),
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
    expect(await main(["attach", "s1", "--host", "https://worker.example"], h.deps)).toBe(EXIT.OK);
    expect(opened).toBe("https://worker.example/s/s1");
    expect(h.json()).toEqual({ id: "s1", url: "https://worker.example/s/s1", opened: true });
    expect(h.stdout.join("")).not.toContain("secret");
  });

  test("beam strips server query data before opening the session browser", async () => {
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
          "fix it",
          "--title",
          "Fix build",
          "--repo",
          "owner/project",
          "--provider",
          "cloudflare",
          "--host",
          "https://worker.example",
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
      env: { SCOTTY_TOKEN: rootToken },
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
      await main(["owner", "recover", "--host", "https://worker.example", "--json"], h.deps),
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

  test("owner recover guides a human through the short-lived browser handoff", async () => {
    const rootToken = "protected-root-token";
    const recoveryCredential =
      "scotty_recovery.111111111111.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const expiresAt = new Date(Date.now() + 5 * 60 * 1_000).toISOString();
    const h = harness({
      env: { SCOTTY_TOKEN: rootToken },
      stdoutIsTTY: true,
      stdinIsTTY: true,
      fetch: async () =>
        Response.json({
          url: `https://worker.example/recover#token=${recoveryCredential}`,
          expiresAt,
        }),
      openBrowser: async () => {},
    });

    expect(await main(["owner", "recover", "--host", "https://worker.example"], h.deps)).toBe(
      EXIT.OK,
    );
    const output = stripVTControlCharacters(h.stdout.join(""));
    expect(output).toContain("Scotty owner recovery");
    expect(output).toContain("Preparing a short-lived, one-use recovery grant");
    expect(output).toContain("Recovery grant issued");
    expect(output).toContain("Opening the secure browser handoff");
    expect(output).toContain(`The handoff expires at ${expiresAt}.`);
    expect(output).toContain("confirm recovery in the browser");
    expect(output).toContain("rerun this command to issue a fresh handoff");
    expect(output).not.toContain(rootToken);
    expect(output).not.toContain(recoveryCredential);
    expect(h.stderr.join("")).toBe("");
  });

  test("owner recover closes the human flow when preparation fails", async () => {
    const rootToken = "protected-root-token";
    const recoveryCredential =
      "scotty_recovery.111111111111.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const expiresAt = new Date(Date.now() + 5 * 60 * 1_000).toISOString();
    const attempts = [
      {
        exit: EXIT.USAGE,
        h: harness({ env: {}, stdoutIsTTY: true, stdinIsTTY: true }),
      },
      {
        exit: EXIT.GENERIC,
        h: harness({
          env: { SCOTTY_TOKEN: rootToken },
          stdoutIsTTY: true,
          stdinIsTTY: true,
          fetch: async () => rejected("network unavailable"),
        }),
      },
      {
        exit: EXIT.GENERIC,
        h: harness({
          env: { SCOTTY_TOKEN: rootToken },
          stdoutIsTTY: true,
          stdinIsTTY: true,
          fetch: async () =>
            Response.json({
              url: `https://attacker.example/recover#token=${recoveryCredential}`,
              expiresAt,
            }),
        }),
      },
    ];

    for (const { exit, h } of attempts) {
      expect(await main(["owner", "recover", "--host", "https://worker.example"], h.deps)).toBe(
        exit,
      );
      const output = stripVTControlCharacters(h.stdout.join(""));
      expect(output).toContain("Recovery handoff could not be prepared");
      expect(output).toContain("No browser handoff was opened");
      expect(output).toContain("then rerun this");
      expect(output).toContain("command.");
      expect(output + h.stderr.join("")).not.toContain(rootToken);
      expect(output + h.stderr.join("")).not.toContain(recoveryCredential);
    }
  });

  test("owner recover closes the human flow when the browser launcher rejects", async () => {
    const rootToken = "protected-root-token";
    const recoveryCredential =
      "scotty_recovery.111111111111.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const expiresAt = new Date(Date.now() + 5 * 60 * 1_000).toISOString();
    const h = harness({
      env: { SCOTTY_TOKEN: rootToken },
      stdoutIsTTY: true,
      stdinIsTTY: true,
      fetch: async () =>
        Response.json({
          url: `https://worker.example/recover#token=${recoveryCredential}`,
          expiresAt,
        }),
      openBrowser: async () => rejected("launcher unavailable"),
    });

    expect(await main(["owner", "recover", "--host", "https://worker.example"], h.deps)).toBe(
      EXIT.GENERIC,
    );
    const output = stripVTControlCharacters(h.stdout.join(""));
    expect(output).toContain("Browser handoff could not be opened");
    expect(output).toContain(`The issued handoff expires at ${expiresAt}.`);
    expect(output).toContain("First check whether the recovery page opened");
    expect(output).toContain("rerun this command for a fresh");
    expect(output).toContain("handoff.");
    expect(h.error()).toEqual({
      error: {
        code: "browser_open_failed",
        message: "Could not open owner recovery in the browser",
        hint: "Check whether the recovery page opened. If not, fix your browser launcher and rerun scotty owner recover.",
      },
    });
    expect(output + h.stderr.join("")).not.toContain(rootToken);
    expect(output + h.stderr.join("")).not.toContain(recoveryCredential);
  });

  test("owner recover preserves the JSON failure envelope when the browser launcher rejects", async () => {
    const rootToken = "protected-root-token";
    const recoveryCredential =
      "scotty_recovery.111111111111.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const expiresAt = new Date(Date.now() + 5 * 60 * 1_000).toISOString();
    const h = harness({
      env: { SCOTTY_TOKEN: rootToken },
      fetch: async () =>
        Response.json({
          url: `https://worker.example/recover#token=${recoveryCredential}`,
          expiresAt,
        }),
      openBrowser: async () => rejected("launcher unavailable"),
    });

    expect(
      await main(["owner", "recover", "--host", "https://worker.example", "--json"], h.deps),
    ).toBe(EXIT.GENERIC);
    expect(h.stdout.join("")).toBe("");
    expect(h.error()).toEqual({
      error: {
        code: "internal_error",
        message: "Scotty failed unexpectedly",
        hint: "Retry with --json; if it persists, inspect the local error and Worker logs.",
      },
    });
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
        env: { SCOTTY_TOKEN: "protected-root-token" },
        fetch: async () => Response.json(reply),
        openBrowser: async () => {
          opened = true;
        },
      });
      expect(await main(["owner", "recover", "--host", "https://worker.example"], h.deps)).toBe(
        EXIT.GENERIC,
      );
      expect(opened).toBe(false);
      expect(h.stdout.join("")).toBe("");
      expect(h.stderr.join("")).not.toContain(credential);
      expect(h.stderr.join("")).not.toContain("protected-root-token");
    }
  });
});
