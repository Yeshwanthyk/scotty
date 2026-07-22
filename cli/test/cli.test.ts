import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EMBEDDED_SKILL, EXIT, main, type CliDependencies } from "../scotty";

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
          url: "https://flag.example/s/s1?t=server-secret",
          branch: "scotty/s1",
          status: "warm",
        });
      },
    });

    const code = await main(
      ["up", "fix it", "--detach", "--host", "https://flag.example/", "--token", "flag-token"],
      h.deps,
    );

    expect(code).toBe(EXIT.OK);
    expect(request?.url).toBe("https://flag.example/api/sessions");
    expect(request?.headers.get("authorization")).toBe("Bearer flag-token");
    expect(await request?.json()).toEqual({ prompt: "fix it" });
    expect(h.json()).toEqual({
      id: "s1",
      url: "https://flag.example/s/s1",
      branch: "scotty/s1",
      status: "warm",
    });
    expect(h.stdout.join("")).not.toContain("server-secret");
  });

  test("up converts the human cap to the Worker contract", async () => {
    let body: unknown;
    const h = harness({
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({
          id: "s1",
          url: "https://worker.example/s/s1",
          branch: "scotty/s1",
          status: "warm",
        });
      },
    });
    expect(
      await main(
        [
          "up",
          "fix it",
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
    expect(body).toEqual({ prompt: "fix it", cap: "90m", hardCapSeconds: 5_400 });

    const invalid = harness();
    expect(
      await main(
        [
          "up",
          "fix it",
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

  test("init writes a 0600 config without echoing the token", async () => {
    const home = await temporaryDirectory();
    const h = harness({ home });
    const code = await main(
      ["init", "--host", "https://worker.example/", "--token", "top-secret"],
      h.deps,
    );
    const configPath = join(home, ".scotty.json");

    expect(code).toBe(EXIT.OK);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      host: "https://worker.example",
      token: "top-secret",
    });
    expect(h.stdout.join("")).not.toContain("top-secret");
    expect(h.prompts()).toBe(0);
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
      status: "warm",
      repo: "anomalyco/rift",
      defaultBranch: "dev",
      branch: "scotty/s1",
      createdAt: "2026-07-20T12:00:00Z",
      updatedAt: "2026-07-20T12:01:00Z",
      hardCapAt: "2026-07-20T16:00:00Z",
      projectedAt: "2026-07-20T12:01:01Z",
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
        status: "warm",
        repo: "anomalyco/rift",
        defaultBranch: "dev",
        branch: "scotty/s1",
        createdAt: "2026-07-20T12:00:00Z",
        updatedAt: "2026-07-20T12:01:00Z",
        hardCapAt: "2026-07-20T16:00:00Z",
        ageSeconds: 60,
        capRemainingSeconds: 14340,
        projectedAt: "2026-07-20T12:01:01Z",
      },
    ]);
    expect(h.stdout.join("")).not.toContain("must-not-leak");
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

  test("snapshot, resume, and pr emit minimal stable schemas", async () => {
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
      [
        ["pr", "s1", "--title", "A fix"],
        {
          prUrl: "https://github.test/pr/1",
          branchUrl: "https://github.test/tree/scotty/s1",
          created: true,
          ignored: true,
        },
        {
          prUrl: "https://github.test/pr/1",
          branchUrl: "https://github.test/tree/scotty/s1",
          created: true,
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

  test("non-TTY vaporize never prompts and sends DELETE", async () => {
    let method = "";
    const h = harness({
      fetch: async (_input, init) => {
        method = init?.method || "GET";
        return Response.json({ id: "s1", status: "gone" });
      },
    });
    expect(
      await main(
        ["vaporize", "s1", "--host", "https://worker.example", "--token", "secret"],
        h.deps,
      ),
    ).toBe(EXIT.OK);
    expect(method).toBe("DELETE");
    expect(h.prompts()).toBe(0);
    expect(h.json()).toEqual({ id: "s1", status: "gone" });
  });

  test("attach opens a tokenized URL but never prints the token", async () => {
    let opened = "";
    const h = harness({
      openBrowser: async (url) => {
        opened = url;
      },
    });
    expect(
      await main(["attach", "s1", "--host", "https://worker.example", "--token", "secret"], h.deps),
    ).toBe(EXIT.OK);
    expect(opened).toBe("https://worker.example/s/s1?t=secret");
    expect(h.json()).toEqual({ id: "s1", url: "https://worker.example/s/s1", opened: true });
    expect(h.stdout.join("")).not.toContain("secret");
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
            branch: "scotty/s1",
            sha,
            codexThreadId: threadId,
            rolloutFile: `rollout-2026-07-20T12-00-00-${threadId}.jsonl`,
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
      await main(["down", "s1", "--host", "https://worker.example", "--token", "secret"], h.deps),
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
      await main(["down", "s1", "--host", "https://worker.example", "--token", "secret"], h.deps),
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
      await main(["down", "s1", "--host", "https://worker.example", "--token", "secret"], h.deps),
    ).toBe(EXIT.GENERIC);
    expect(ran).toBe(false);
    expect(h.error().error.code).toBe("invalid_archive");
  });

  test("skills and help --agents share the exact embedded source", async () => {
    const skills = harness();
    const agents = harness();
    expect(await main(["skills"], skills.deps)).toBe(EXIT.OK);
    expect(await main(["help", "--agents"], agents.deps)).toBe(EXIT.OK);
    expect(skills.stdout.join("")).toBe(EMBEDDED_SKILL);
    expect(agents.stdout.join("")).toBe(EMBEDDED_SKILL);
  });

  test("skills install --here writes the skill and idempotent AGENTS pointer", async () => {
    const cwd = await temporaryDirectory();
    await mkdir(cwd, { recursive: true });
    const first = harness({ cwd });
    const second = harness({ cwd });
    expect(await main(["skills", "install", "--here", "--json"], first.deps)).toBe(EXIT.OK);
    expect(await main(["skills", "install", "--here", "--json"], second.deps)).toBe(EXIT.OK);
    expect(await readFile(join(cwd, ".agents", "scotty.md"), "utf8")).toBe(EMBEDDED_SKILL);
    const agents = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agents.match(/<!-- scotty-skill -->/g)?.length).toBe(1);
  });
});
