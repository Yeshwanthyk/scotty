import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setThemeInstance, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { getCapabilities, type MarkdownTheme } from "@earendil-works/pi-tui";
import { Option, Schema } from "effect";
import { embeddedThemeSource, type EmbeddedThemeName } from "./theme-assets.ts";

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
type ThemeName = EmbeddedThemeName;
type ColorValue = string | number;

const ColorValueSchema = Schema.Union([
  Schema.String,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
]);
type ColorFields<Keys extends ReadonlyArray<string>> = {
  readonly [Key in Keys[number]]: typeof ColorValueSchema;
};
const colorFields = <const Keys extends ReadonlyArray<string>>(keys: Keys): ColorFields<Keys> =>
  Object.fromEntries(keys.map((key) => [key, ColorValueSchema])) as ColorFields<Keys>;

const ColorMapSchema = Schema.Struct(
  colorFields([...FOREGROUND_KEYS, ...BACKGROUND_KEYS] as const),
);
const ThemeExportSchema = Schema.Struct({
  pageBg: Schema.optionalKey(ColorValueSchema),
  cardBg: Schema.optionalKey(ColorValueSchema),
  infoBg: Schema.optionalKey(ColorValueSchema),
});
const ThemeFileSchema = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  name: Schema.String,
  vars: Schema.optionalKey(Schema.Record(Schema.String, ColorValueSchema)),
  colors: ColorMapSchema,
  export: Schema.optionalKey(ThemeExportSchema),
});
type ThemeFile = typeof ThemeFileSchema.Type;
type ThemeColors = typeof ColorMapSchema.Type;
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const ThemeObjectShapeSchema = Schema.Struct({
  $schema: Schema.optionalKey(Schema.Unknown),
  name: Schema.optionalKey(Schema.Unknown),
  vars: Schema.optionalKey(Schema.Unknown),
  colors: Schema.optionalKey(Schema.Unknown),
  export: Schema.optionalKey(Schema.Unknown),
});
const ThemeExportShapeSchema = Schema.Struct({
  pageBg: Schema.optionalKey(Schema.Unknown),
  cardBg: Schema.optionalKey(Schema.Unknown),
  infoBg: Schema.optionalKey(Schema.Unknown),
});
const ColorShapeSchema = Schema.Struct(
  Object.fromEntries(
    [...FOREGROUND_KEYS, ...BACKGROUND_KEYS].map((key) => [
      key,
      Schema.optionalKey(Schema.Unknown),
    ]),
  ) as {
    readonly [Key in
      | (typeof FOREGROUND_KEYS)[number]
      | (typeof BACKGROUND_KEYS)[number]]: Schema.optionalKey<typeof Schema.Unknown>;
  },
);
const decodeThemeFileOption = Schema.decodeUnknownOption(ThemeFileSchema, {
  onExcessProperty: "error",
});
const decodeThemeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const decodeJsonObjectOption = Schema.decodeUnknownOption(JsonObjectSchema);
const decodeThemeObjectShapeOption = Schema.decodeUnknownOption(ThemeObjectShapeSchema, {
  onExcessProperty: "error",
});
const decodeThemeExportShapeOption = Schema.decodeUnknownOption(ThemeExportShapeSchema, {
  onExcessProperty: "error",
});
const decodeColorShapeOption = Schema.decodeUnknownOption(ColorShapeSchema, {
  onExcessProperty: "error",
});
const decodeStringOption = Schema.decodeUnknownOption(Schema.String);
const decodeThemeExportOption = Schema.decodeUnknownOption(ThemeExportSchema);
const decodeVariablesOption = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, ColorValueSchema),
);
const decodeColorsOption = Schema.decodeUnknownOption(ColorMapSchema);

const themeError = (message: string): Error => Error(message);

const resolveColor = (
  value: ColorValue,
  variables: Readonly<Record<string, ColorValue>>,
  visited = new Set<string>(),
): ColorValue => {
  if (typeof value === "number" || value === "" || /^#[0-9a-f]{6}$/iu.test(value)) return value;
  if (!/^[A-Za-z0-9_.-]+$/u.test(value) || visited.has(value) || !(value in variables))
    throw themeError(`Invalid packaged Pi theme color reference: ${value}`);
  const nextVisited = new Set(visited);
  nextVisited.add(value);
  return resolveColor(variables[value] ?? "", variables, nextVisited);
};

const resolveColors = <const Keys extends ReadonlyArray<keyof ThemeColors>>(
  keys: Keys,
  colors: ThemeColors,
  variables: Readonly<Record<string, ColorValue>>,
): { readonly [Key in Keys[number]]: ColorValue } =>
  Object.fromEntries(keys.map((key) => [key, resolveColor(colors[key], variables)])) as {
    readonly [Key in Keys[number]]: ColorValue;
  };

const parsePiPresentationTheme = (
  name: ThemeName,
  source: string,
  sourcePath: string,
  mode: "truecolor" | "256color",
): Theme => {
  const json = Option.getOrUndefined(decodeThemeJsonOption(source));
  if (json === undefined) {
    JSON.parse(source);
    throw themeError("Packaged Pi theme has an invalid shape");
  }
  const object = Option.getOrUndefined(decodeJsonObjectOption(json));
  if (object === undefined) throw themeError("Packaged Pi theme must be an object");
  const shaped = Option.getOrUndefined(decodeThemeObjectShapeOption(object));
  if (shaped === undefined) throw themeError("Packaged Pi theme contains an unsupported field");

  const parsedName = Option.getOrUndefined(decodeStringOption(shaped.name));
  const colorsObject = Option.getOrUndefined(decodeJsonObjectOption(shaped.colors));
  if (parsedName !== name || colorsObject === undefined)
    throw themeError(`Packaged Pi ${name} theme has an invalid identity`);
  if (shaped.$schema !== undefined && Option.isNone(decodeStringOption(shaped.$schema)))
    throw themeError("Packaged Pi theme schema must be a string");

  let exportColors: typeof ThemeExportSchema.Type | undefined;
  if (shaped.export !== undefined) {
    const exportObject = Option.getOrUndefined(decodeJsonObjectOption(shaped.export));
    if (exportObject === undefined) throw themeError("Packaged Pi theme export must be an object");
    if (Option.isNone(decodeThemeExportShapeOption(exportObject)))
      throw themeError("Packaged Pi theme contains an unsupported field");
    exportColors = Option.getOrUndefined(decodeThemeExportOption(exportObject));
    if (exportColors === undefined)
      throw themeError("Packaged Pi theme export contains an invalid color");
  }

  let variables: Readonly<Record<string, ColorValue>> = {};
  if (shaped.vars !== undefined) {
    const variablesObject = Option.getOrUndefined(decodeJsonObjectOption(shaped.vars));
    if (variablesObject === undefined) throw themeError("Packaged Pi theme vars must be an object");
    variables =
      Option.getOrUndefined(decodeVariablesOption(variablesObject)) ??
      (() => {
        throw themeError("Packaged Pi theme contains an invalid variable");
      })();
  }

  if (Option.isNone(decodeColorShapeOption(colorsObject)))
    throw themeError("Packaged Pi theme contains an unsupported field");
  const colors = Option.getOrUndefined(decodeColorsOption(colorsObject));
  if (colors === undefined) throw themeError("Packaged Pi theme is missing a required color");

  const parsed: ThemeFile | undefined = Option.getOrUndefined(
    decodeThemeFileOption({
      ...(shaped.$schema === undefined ? {} : { $schema: shaped.$schema }),
      name: parsedName,
      ...(shaped.vars === undefined ? {} : { vars: variables }),
      colors,
      ...(exportColors === undefined ? {} : { export: exportColors }),
    }),
  );
  if (parsed === undefined) throw themeError("Packaged Pi theme has an invalid shape");
  const typedVariables = parsed.vars ?? {};

  const foreground = resolveColors(FOREGROUND_KEYS, colors, typedVariables) satisfies Record<
    ThemeColor,
    ColorValue
  >;
  const background = resolveColors(BACKGROUND_KEYS, colors, typedVariables);
  return new Theme(foreground, background, mode, {
    name,
    sourcePath,
  });
};

export const loadPiPresentationTheme = (
  name: ThemeName,
  themeDirectory: string,
  mode: "truecolor" | "256color" = getCapabilities().trueColor ? "truecolor" : "256color",
): Theme => {
  const sourcePath = join(themeDirectory, `${name}.json`);
  return parsePiPresentationTheme(name, readFileSync(sourcePath, "utf8"), sourcePath, mode);
};

export const loadEmbeddedPiPresentationTheme = (
  name: ThemeName,
  mode: "truecolor" | "256color" = getCapabilities().trueColor ? "truecolor" : "256color",
): Theme =>
  parsePiPresentationTheme(
    name,
    embeddedThemeSource(name),
    `embedded:scotty-tui/${name}.json`,
    mode,
  );

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

export interface PiPresentationTheme {
  readonly theme: Theme;
  readonly markdown: MarkdownTheme;
}

let presentation: PiPresentationTheme | undefined;

const markdownTheme = (theme: Theme): MarkdownTheme => ({
  heading: (text) => theme.fg("mdHeading", text),
  link: (text) => theme.fg("mdLink", text),
  linkUrl: (text) => theme.fg("mdLinkUrl", text),
  code: (text) => theme.fg("mdCode", text),
  codeBlock: (text) => theme.fg("mdCodeBlock", text),
  codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
  quote: (text) => theme.fg("mdQuote", text),
  quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
  hr: (text) => theme.fg("mdHr", text),
  listBullet: (text) => theme.fg("mdListBullet", text),
  bold: (text) => theme.bold(text),
  italic: (text) => theme.italic(text),
  strikethrough: (text) => theme.strikethrough(text),
  underline: (text) => theme.underline(text),
});

export const initializePiPresentation = (): PiPresentationTheme => {
  if (presentation !== undefined) return presentation;
  const name = detectPiThemeName();
  const theme = loadEmbeddedPiPresentationTheme(name);
  setThemeInstance(theme);
  presentation = { theme, markdown: markdownTheme(theme) };
  return presentation;
};
