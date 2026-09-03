import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineVars({
  space: "#0a0a0a",
  shell: "#111111",
  panel: "#121212",
  panelRaised: "#181818",
  control: "#101010",
  ink: "#f5f5f5",
  muted: "rgb(255 255 255 / 0.62)",
  quiet: "rgb(255 255 255 / 0.46)",
  line: "rgb(255 255 255 / 0.12)",
  lineSoft: "rgb(255 255 255 / 0.08)",
  lineHover: "rgb(255 255 255 / 0.16)",
  beam: "#f5f5f5",
  accent: "#cf633f",
  accentStrong: "#e07954",
  focus: "#7ed9e8",
  danger: "oklch(70% 0.16 25)",
  success: "#82b394",
  warning: "#dab77e",
});

export const spacing = stylex.defineVars({
  xs: "4px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "24px",
  xxl: "32px",
});

export const motion = stylex.defineVars({
  fast: "120ms",
  standard: "180ms",
  easeOut: "cubic-bezier(0.22, 1, 0.36, 1)",
});
