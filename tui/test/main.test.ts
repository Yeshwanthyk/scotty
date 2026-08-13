import { describe, expect, it } from "vitest";
import { pairTuiClient, runTuiConsole } from "../src/main.ts";

describe("embedded scotty tui runtime", () => {
  it("exports library APIs without auto-executing a process entrypoint", () => {
    expect(pairTuiClient).toBeTypeOf("function");
    expect(runTuiConsole).toBeTypeOf("function");
  });

  it("reports the public scotty tui command when no interactive terminal is available", async () => {
    if (process.stdin.isTTY && process.stdout.isTTY) return;
    await expect(runTuiConsole("/does/not/matter.json")).rejects.toMatchObject({
      code: "input_invalid",
      message: "scotty tui requires an interactive terminal",
    });
  });
});
