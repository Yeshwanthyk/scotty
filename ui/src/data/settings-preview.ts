export const isSettingsPreview = (search: string, development: boolean): boolean =>
  development && new URLSearchParams(search).get("preview") === "1";
