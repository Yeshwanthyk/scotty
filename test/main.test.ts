import { describe, expect, test } from "bun:test";

import { runCli } from "../src/main";
import type { CliIo, LifecycleBackend } from "../src/types";

function fixture(): { backend: LifecycleBackend; io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    backend: {
      up: async () => ({ id: "beam_one", status: "active", url: "https://beam.test/sessions/beam_one" }),
      down: async ({ id }) => ({ id, status: "down", resume: ["codex", "resume", "one"] }),
      vaporize: async (id) => ({ id, status: "vaporized", url: `https://beam.test/sessions/${id}` }),
      resume: async (id) => ({ id, status: "waking", url: `https://beam.test/sessions/${id}` }),
      list: async () => ({ sessions: [] }),
      status: async (id) => ({
        id,
        status: "suspended",
        url: `https://beam.test/sessions/${id}`,
        provider: "codex",
        project: "yesh/repo",
        title: null,
        updatedAt: 0,
        queuedPrompts: 0,
        deleted: false,
        heartbeatAt: null,
        flushAt: null,
        error: null,
      }),
    },
  };
}

describe("public lifecycle", () => {
  test("up prints the stable id and phone link", async () => {
    const f = fixture();
    expect(await runCli(["beam", "up"], f)).toBe(0);
    expect(f.stdout.join("")).toContain("ID:    beam_one");
    expect(f.stdout.join("")).toContain("Phone: https://beam.test/sessions/beam_one");
  });

  test("down, vaporize, and resume all require and preserve the same id", async () => {
    for (const action of ["down", "vaporize", "resume"] as const) {
      const f = fixture();
      expect(await runCli(["beam", action, "beam_one", "--json"], f)).toBe(0);
      expect(JSON.parse(f.stdout.join(""))).toMatchObject({ ok: true, id: "beam_one" });
    }
  });

  test("missing ids fail without calling the backend", async () => {
    const f = fixture();
    expect(await runCli(["beam", "resume"], f)).toBe(1);
    expect(f.stderr.join("")).toContain("requires exactly one id");
  });

  test("list, status, and help are available without adding lifecycle mutations", async () => {
    for (const argv of [
      ["beam", "list"],
      ["beam", "status", "beam_one"],
      ["beam", "help", "up"],
    ]) {
      const f = fixture();
      expect(await runCli(argv, f)).toBe(0);
    }
  });
});
