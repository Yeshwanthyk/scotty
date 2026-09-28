import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineVars({
  // The values live in global.css so light and dark follow the system.
  space: "var(--bg)",
  shell: "var(--bg)",
  panel: "var(--surface)",
  panelRaised: "var(--raised)",
  control: "var(--sunken)",
  ink: "var(--ink)",
  muted: "var(--muted)",
  quiet: "var(--quiet)",
  line: "var(--line-strong)",
  lineSoft: "var(--line)",
  lineHover: "var(--line-hover)",
  beam: "var(--ink)",
  accent: "var(--accent)",
  accentStrong: "var(--accent-strong)",
  focus: "var(--link)",
  danger: "var(--danger)",
  success: "var(--success)",
  warning: "var(--warning)",
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
