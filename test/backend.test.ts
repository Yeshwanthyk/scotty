import { describe, expect, test } from "bun:test";

import { createBackend, type EngineCommandResult } from "../src/backend";

function result(body: unknown): EngineCommandResult {
  return { exitCode: 0, stdout: JSON.stringify(body), stderr: "" };
}

describe("Scotty backend mapping", () => {
  test("up maps local work to the transport engine and returns the Scotty id", async () => {
    const calls: string[][] = [];
    const backend = createBackend({
      runBeam: async (args) => {
        calls.push(args);
        return result({ ok: true, beamId: "beam_one", sessionUrl: "https://beam.test/sessions/beam_one" });
      },
    });

    expect(await backend.up({ force: false, cwd: "/repo", session: "codex:one" })).toEqual({
      id: "beam_one",
      status: "waking",
      url: "https://beam.test/sessions/beam_one",
    });
    expect(calls).toEqual([["push", "codex:one", "--json", "--cwd", "/repo"]]);
  });

  test("up project mode maps to a fresh session without adding a public verb", async () => {
    const calls: string[][] = [];
    const backend = createBackend({
      runBeam: async (args) => {
        calls.push(args);
        return result({ ok: true, beamId: "beam_new", sessionUrl: "https://beam.test/sessions/beam_new", wake: { status: "waking" } });
      },
    });

    expect(await backend.up({ force: false, project: "yesh/repo", provider: "codex", prompt: "work" })).toMatchObject({
      id: "beam_new",
      status: "waking",
    });
    expect(calls).toEqual([["new", "yesh/repo", "--json", "--provider", "codex", "--prompt", "work"]]);
  });

  test("up turns a missing git origin into an actionable Scotty failure", async () => {
    const backend = createBackend({
      runBeam: async () => ({
        exitCode: 1,
        stdout: JSON.stringify({ ok: false, error: "beam push requires remote.origin.url for git-backed sync" }),
        stderr: "",
      }),
    });

    await expect(backend.up({ force: false, session: "codex:one" })).rejects.toThrow(
      "Scotty can't upload this session because this repository has no origin. Add a reachable private Git remote as origin, then retry `scotty beam up`.",
    );
  });

  test("down maps to transport pull on the requesting machine", async () => {
    const calls: string[][] = [];
    const backend = createBackend({
      runBeam: async (args) => {
        calls.push(args);
        return result({ ok: true, beamId: "beam_one", resume: ["codex", "resume", "one"] });
      },
    });

    expect(await backend.down({ id: "beam_one", cwd: "/repo", force: true })).toEqual({
      id: "beam_one",
      status: "down",
      resume: ["codex", "resume", "one"],
    });
    expect(calls).toEqual([["pull", "beam_one", "--json", "--cwd", "/repo", "--force"]]);
  });

  test("vaporize and resume use the exact id against the control plane", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const backend = createBackend({
      env: { SCOTTY_API_URL: "https://beam.test/", SCOTTY_TOKEN: "secret" },
      fetch: async (input, init) => {
        calls.push({ input, init });
        const status = input.endsWith("/suspend") ? "suspended" : "waking";
        return Response.json({ status });
      },
    });

    expect(await backend.vaporize("beam_one")).toEqual({
      id: "beam_one",
      status: "vaporized",
      url: "https://beam.test/sessions/beam_one",
    });
    expect(await backend.resume("beam_one")).toEqual({
      id: "beam_one",
      status: "waking",
      url: "https://beam.test/sessions/beam_one",
    });
    expect(calls.map((call) => call.input)).toEqual([
      "https://beam.test/v1/sessions/beam_one/suspend",
      "https://beam.test/v1/sessions/beam_one/wake",
    ]);
    expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBe("Bearer secret");
  });

  test("list and status bypass local provider scanning", async () => {
    const session = {
      beam_id: "beam_one",
      status: "suspended",
      provider: "codex",
      project: "yesh/repo",
      title: "Fix it",
      updated_at: 123,
      queued_prompt_count: 0,
      deleted_at: null,
      error_reason: null,
    };
    const backend = createBackend({
      env: { SCOTTY_API_URL: "https://beam.test", SCOTTY_TOKEN: "secret", SCOTTY_GATEWAY_HOST: "ssh.beam.test:2222" },
      fetch: async (input) => input.endsWith("/v1/sessions")
        ? Response.json({ sessions: [session] })
        : Response.json({ session, lastHeartbeat: 100, lastFlush: 110 }),
    });

    expect(await backend.list(false)).toMatchObject({
      sessions: [{ id: "beam_one", status: "suspended", ssh: "ssh -p 2222 beam_one@ssh.beam.test" }],
    });
    expect(await backend.status("beam_one")).toMatchObject({
      id: "beam_one",
      heartbeatAt: 100,
      flushAt: 110,
    });
  });

  test("Scotty config is primary and the legacy config path is only a fallback", async () => {
    const reads: string[] = [];
    const backend = createBackend({
      env: {},
      home: "/home/test",
      readText: async (path) => {
        reads.push(path);
        if (path.endsWith("/.config/scotty/config.json")) {
          return JSON.stringify({ apiUrl: "https://scotty.test", token: "secret" });
        }
        throw new Error("legacy config should not be read");
      },
      fetch: async () => Response.json({ sessions: [] }),
    });

    expect(await backend.list(false)).toEqual({ sessions: [] });
    expect(reads).toEqual(["/home/test/.config/scotty/config.json"]);
  });
});
