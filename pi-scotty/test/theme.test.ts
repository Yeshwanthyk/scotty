import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectPiThemeName, loadPiPresentationTheme } from "../src/theme.ts";

const entry = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
const themeDirectory = join(dirname(fileURLToPath(entry)), "modes", "interactive", "theme");

describe("exact Pi 0.83 presentation theme", () => {
  it("preserves semantic colors in the published dark and light assets", () => {
    const dark = loadPiPresentationTheme("dark", themeDirectory, "truecolor");
    const light = loadPiPresentationTheme("light", themeDirectory, "truecolor");

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
  });

  it("matches Pi 0.83 COLORFGBG light and dark selection", () => {
    expect(detectPiThemeName({ COLORFGBG: "15;0" })).toBe("dark");
    expect(detectPiThemeName({ COLORFGBG: "0;15" })).toBe("light");
    expect(detectPiThemeName({})).toBe("dark");
  });
});
