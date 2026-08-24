import { describe, expect, it } from "vitest";
import { runTuiConsole } from "../src/main.ts";

const config = {
  version: 1 as const,
  origin: "https://scotty.example",
  credential: `scotty_client.0123456789ab.${"c".repeat(32)}`,
};

describe("embedded scotty tui runtime", () => {
  it("exports the in-memory TUI entrypoint without auto-executing a process entrypoint", () => {
    expect(runTuiConsole).toBeTypeOf("function");
  });

  it("reports the public scotty tui command when no interactive terminal is available", async () => {
    if (process.stdin.isTTY && process.stdout.isTTY) return;
    await expect(runTuiConsole(config)).rejects.toMatchObject({
      code: "input_invalid",
      message: "scotty tui requires an interactive terminal",
    });
  });
});
