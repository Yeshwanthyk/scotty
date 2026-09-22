import { describe, expect, it } from "vitest";
import {
  settingsPreviewCredentials,
  settingsPreviewRepositories,
  settingsPreviewResources,
  settingsPreviewSnapshot,
} from "../fixtures/settings";
import { isSettingsPreview } from "./settings-preview";

describe("settings local preview", () => {
  it("requires the exact development-only query", () => {
    expect(isSettingsPreview("?preview=1", true)).toBe(true);
    expect(isSettingsPreview("?preview=10", true)).toBe(false);
    expect(isSettingsPreview("?preview=1", false)).toBe(false);
  });

  it("provides honest data for every settings surface", () => {
    expect(settingsPreviewSnapshot.settings.agent).toBe("pi");
    expect(settingsPreviewSnapshot.settings.environment).not.toEqual({});
    expect(settingsPreviewRepositories.length).toBeGreaterThan(0);
    expect(settingsPreviewResources.items.map(({ kind }) => kind)).toEqual(["skill", "extension"]);
    expect(settingsPreviewCredentials.map(({ kind }) => kind)).toEqual(["pi-auth", "github-cli"]);
  });
});
