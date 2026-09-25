import { describe, expect, it } from "vitest";
import { isSettingsPreview } from "./settings-preview";

describe("settings local preview", () => {
  it("requires the exact development-only query", () => {
    expect(isSettingsPreview("?preview=1", true)).toBe(true);
    expect(isSettingsPreview("?preview=10", true)).toBe(false);
    expect(isSettingsPreview("?preview=1", false)).toBe(false);
  });
});
