import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getMarkdownTheme,
  initTheme,
  Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, type MarkdownTheme } from "@earendil-works/pi-tui";

const BACKGROUND_KEYS = [
  "selectedBg",
  "scrollbarThumb",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
] as const;
const FOREGROUND_KEYS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
] as const satisfies ReadonlyArray<ThemeColor>;
const TOP_LEVEL_KEYS = new Set(["$schema", "name", "vars", "colors", "export"]);
const EXPORT_KEYS = new Set(["pageBg", "cardBg", "infoBg"]);
const COLOR_KEYS = new Set([...FOREGROUND_KEYS, ...BACKGROUND_KEYS]);

type ThemeName = "dark" | "light";
type ColorValue = string | number;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const colorValue = (value: unknown): value is ColorValue =>
  (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255) ||
  typeof value === "string";

const assertExactKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): void => {
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("Packaged Pi theme contains an unsupported field");
};

const resolveColor = (
  value: ColorValue,
  variables: Readonly<Record<string, ColorValue>>,
  visited = new Set<string>(),
): ColorValue => {
  if (typeof value === "number" || value === "" || /^#[0-9a-f]{6}$/iu.test(value)) return value;
  if (!/^[A-Za-z0-9_.-]+$/u.test(value) || visited.has(value) || !(value in variables))
    throw new Error(`Invalid packaged Pi theme color reference: ${value}`);
  const nextVisited = new Set(visited);
  nextVisited.add(value);
  return resolveColor(variables[value] ?? "", variables, nextVisited);
};

export const loadPiPresentationTheme = (
  name: ThemeName,
  themeDirectory: string,
  mode: "truecolor" | "256color" = getCapabilities().trueColor ? "truecolor" : "256color",
): Theme => {
  const parsed: unknown = JSON.parse(readFileSync(join(themeDirectory, `${name}.json`), "utf8"));
  if (!isRecord(parsed)) throw new Error("Packaged Pi theme must be an object");
  assertExactKeys(parsed, TOP_LEVEL_KEYS);
  const colors = parsed.colors;
  if (parsed.name !== name || !isRecord(colors))
    throw new Error(`Packaged Pi ${name} theme has an invalid identity`);
  if (parsed.$schema !== undefined && typeof parsed.$schema !== "string")
    throw new Error("Packaged Pi theme schema must be a string");
  if (parsed.export !== undefined) {
    if (!isRecord(parsed.export)) throw new Error("Packaged Pi theme export must be an object");
    assertExactKeys(parsed.export, EXPORT_KEYS);
    if (Object.values(parsed.export).some((value) => !colorValue(value)))
      throw new Error("Packaged Pi theme export contains an invalid color");
  }
  const variables = parsed.vars;
  if (variables !== undefined && !isRecord(variables))
    throw new Error("Packaged Pi theme vars must be an object");
  const typedVariables = variables ?? {};
  if (Object.values(typedVariables).some((value) => !colorValue(value)))
    throw new Error("Packaged Pi theme contains an invalid variable");
  assertExactKeys(colors, COLOR_KEYS);
  if (
    [...FOREGROUND_KEYS, ...BACKGROUND_KEYS].some(
      (key) => !(key in colors) || !colorValue(colors[key]),
    )
  )
    throw new Error("Packaged Pi theme is missing a required color");

  const resolved = Object.fromEntries(
    Object.entries(colors).map(([key, value]) => [
      key,
      resolveColor(value as ColorValue, typedVariables as Record<string, ColorValue>),
    ]),
  );
  // Exact key validation above proves both constructor records are complete.
  const foreground = Object.fromEntries(
    FOREGROUND_KEYS.map((key) => [key, resolved[key] as ColorValue]),
  ) as Record<ThemeColor, ColorValue>;
  const background = Object.fromEntries(
    BACKGROUND_KEYS.map((key) => [key, resolved[key] as ColorValue]),
  ) as ConstructorParameters<typeof Theme>[1];
  return new Theme(foreground, background, mode, {
    name,
    sourcePath: join(themeDirectory, `${name}.json`),
  });
};

const ansiRgb = (index: number): readonly [number, number, number] => {
  const basic = [
    0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0x808080,
    0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
  ];
  const packed = basic[index];
  if (packed !== undefined) return [packed >> 16, (packed >> 8) & 0xff, packed & 0xff];
  if (index < 232) {
    const cube = index - 16;
    const channel = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
    return [
      channel(Math.floor(cube / 36)),
      channel(Math.floor((cube % 36) / 6)),
      channel(cube % 6),
    ];
  }
  const gray = 8 + (index - 232) * 10;
  return [gray, gray, gray];
};

const luminance = ([red, green, blue]: readonly number[]): number => {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red ?? 0) + 0.7152 * linear(green ?? 0) + 0.0722 * linear(blue ?? 0);
};

export const detectPiThemeName = (environment: NodeJS.ProcessEnv = process.env): ThemeName => {
  const parts = (environment.COLORFGBG ?? "").split(";");
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const background = Number.parseInt(parts[index]?.trim() ?? "", 10);
    if (Number.isInteger(background) && background >= 0 && background <= 255)
      return luminance(ansiRgb(background)) >= 0.5 ? "light" : "dark";
  }
  return "dark";
};

const sourceThemeDirectory = (): string => {
  const entry = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return join(dirname(fileURLToPath(entry)), "modes", "interactive", "theme");
};

const runtimeThemeDirectory = (): string =>
  /(?:\$bunfs|~BUN|%7EBUN)/u.test(import.meta.url)
    ? join(dirname(process.execPath), "theme")
    : sourceThemeDirectory();

export interface PiPresentationTheme {
  readonly theme: Theme;
  readonly markdown: MarkdownTheme;
}

let presentation: PiPresentationTheme | undefined;

export const initializePiPresentation = (): PiPresentationTheme => {
  if (presentation !== undefined) return presentation;
  const name = detectPiThemeName();
  const theme = loadPiPresentationTheme(name, runtimeThemeDirectory());
  initTheme(name, false);
  presentation = { theme, markdown: getMarkdownTheme() };
  return presentation;
};
