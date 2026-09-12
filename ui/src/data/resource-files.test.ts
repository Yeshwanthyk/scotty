import { describe, expect, it } from "vitest";
import { prepareBrowserResourceFiles } from "./resource-files";

describe("browser resource upload", () => {
  it("preserves tool execution intent in the API payload", async () => {
    const [tool] = await prepareBrowserResourceFiles(
      [new File(["#!/bin/sh\necho ready\n"], "check.sh")],
      "tool",
      false,
    );
    expect(tool).toEqual({
      path: "check.sh",
      contentBase64: btoa("#!/bin/sh\necho ready\n"),
      modeClass: "executable",
    });
  });
});
