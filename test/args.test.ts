import { describe, expect, test } from "bun:test";

import { parseArgs, UsageError } from "../src/args";

describe("argument contract", () => {
  test("up is the only command without an id", () => {
    const up = parseArgs(["beam", "up"]);
    expect(up.action).toBe("up");
    expect(up.id).toBeUndefined();
    for (const action of ["down", "vaporize", "resume"]) {
      expect(() => parseArgs(["beam", action])).toThrow(UsageError);
    }
  });

  test("all non-up commands accept exactly one stable id", () => {
    expect(parseArgs(["beam", "down", "beam_abc"])).toMatchObject({ action: "down", id: "beam_abc" });
    expect(parseArgs(["beam", "vaporize", "beam_abc"])).toMatchObject({ action: "vaporize", id: "beam_abc" });
    expect(parseArgs(["beam", "resume", "beam_abc"])).toMatchObject({ action: "resume", id: "beam_abc" });
    expect(parseArgs(["beam", "status", "beam_abc"])).toMatchObject({ action: "status", id: "beam_abc" });
  });

  test("up selects a local session by flag, never by a cloud id", () => {
    expect(parseArgs(["beam", "up", "--session", "codex:session-1", "--cwd", "/repo"])).toMatchObject({
      action: "up",
      session: "codex:session-1",
      cwd: "/repo",
    });
    expect(() => parseArgs(["beam", "up", "beam_abc"])).toThrow("does not take an id");
  });

  test("project mode remains inside the up verb", () => {
    expect(parseArgs(["beam", "up", "--project", "yesh/repo", "--provider=codex", "--prompt", "fix it"])).toMatchObject({
      action: "up",
      project: "yesh/repo",
      provider: "codex",
      prompt: "fix it",
    });
  });

  test("list and help are read-only support commands", () => {
    expect(parseArgs(["beam", "list", "--all"])).toMatchObject({ action: "list", all: true });
    expect(parseArgs(["beam", "help", "vaporize"])).toMatchObject({ action: "help", id: "vaporize" });
  });
});
