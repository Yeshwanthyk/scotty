import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { embeddedThemeSource } from "../src/theme-assets.ts";
import {
  detectPiThemeName,
  loadEmbeddedPiPresentationTheme,
  loadPiPresentationTheme,
} from "../src/theme.ts";

const entry = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
const themeDirectory = join(dirname(fileURLToPath(entry)), "modes", "interactive", "theme");
const decodeJsonObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));
const decodePublishedTheme = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const publishedTheme = (): Schema.JsonObject =>
  decodePublishedTheme(readFileSync(join(themeDirectory, "dark.json"), "utf8"));

const expectThemeError = (payload: Schema.Json, message: string): void => {
  const directory = mkdtempSync(join(tmpdir(), "scotty-tui-theme-"));
  try {
    writeFileSync(join(directory, "dark.json"), JSON.stringify(payload));
    expect(() => loadPiPresentationTheme("dark", directory, "truecolor")).toThrow(message);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("exact Pi 0.84 presentation theme", () => {
  it("preserves semantic colors in the published dark and light assets", () => {
    const dark = loadEmbeddedPiPresentationTheme("dark", "truecolor");
    const light = loadEmbeddedPiPresentationTheme("light", "truecolor");

    expect(dark.getFgAnsi("accent")).toBe("\u001b[38;2;138;190;183m");
    expect(dark.getFgAnsi("success")).toBe("\u001b[38;2;181;189;104m");
    expect(dark.getFgAnsi("error")).toBe("\u001b[38;2;204;102;102m");
    expect(dark.getFgAnsi("warning")).toBe("\u001b[38;2;255;255;0m");
    expect(dark.getFgAnsi("muted")).toBe("\u001b[38;2;128;128;128m");
    expect(light.getFgAnsi("accent")).toBe("\u001b[38;2;90;128;128m");
    expect(light.getFgAnsi("success")).toBe("\u001b[38;2;88;132;88m");
    expect(light.getFgAnsi("error")).toBe("\u001b[38;2;170;85;85m");
    expect(light.getFgAnsi("warning")).toBe("\u001b[38;2;154;115;38m");
    expect(light.getFgAnsi("muted")).toBe("\u001b[38;2;108;108;108m");
    expect(dark.sourcePath).toBe("embedded:scotty-tui/dark.json");
    expect(light.sourcePath).toBe("embedded:scotty-tui/light.json");
  });

  it("embeds the exact pinned Pi theme JSON instead of reading runtime assets", () => {
    for (const name of ["dark", "light"] as const) {
      const published = decodePublishedTheme(
        readFileSync(join(themeDirectory, `${name}.json`), "utf8"),
      );
      expect(decodePublishedTheme(embeddedThemeSource(name))).toEqual(published);
    }
  });

  it("matches Pi 0.84 COLORFGBG light and dark selection", () => {
    expect(detectPiThemeName({ COLORFGBG: "15;0" })).toBe("dark");
    expect(detectPiThemeName({ COLORFGBG: "0;15" })).toBe("light");
    expect(detectPiThemeName({})).toBe("dark");
  });

  it("preserves the non-object and unsupported-field errors", () => {
    expectThemeError(null, "Packaged Pi theme must be an object");
    expectThemeError({ ...publishedTheme(), unsupported: true }, "contains an unsupported field");
  });

  it("preserves identity and schema errors", () => {
    expectThemeError({ ...publishedTheme(), name: "light" }, "dark theme has an invalid identity");
    expectThemeError({ ...publishedTheme(), $schema: true }, "theme schema must be a string");
  });

  it("preserves export and variable errors", () => {
    const base = publishedTheme();
    expectThemeError({ ...base, export: true }, "theme export must be an object");
    expectThemeError({ ...base, export: { unsupported: "#fff" } }, "contains an unsupported field");
    expectThemeError({ ...base, export: { pageBg: true } }, "export contains an invalid color");
    expectThemeError({ ...base, vars: true }, "theme vars must be an object");
    expectThemeError({ ...base, vars: { accent: true } }, "contains an invalid variable");
  });

  it("preserves missing and invalid color errors", () => {
    const base = publishedTheme();
    const colors = { ...decodeJsonObject(base.colors) };
    delete colors.accent;
    expectThemeError({ ...base, colors }, "missing a required color");
    expectThemeError(
      { ...base, colors: { ...decodeJsonObject(base.colors), accent: true } },
      "missing a required color",
    );
  });
});
