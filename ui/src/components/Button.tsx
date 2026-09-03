import * as stylex from "@stylexjs/stylex";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { colors, motion, spacing } from "../theme/tokens.stylex";

const styles = stylex.create({
  button: {
    minHeight: "40px",
    paddingBlock: spacing.sm,
    paddingInline: spacing.md,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "8px",
    backgroundColor: colors.control,
    color: colors.ink,
    fontSize: "13px",
    fontWeight: 650,
    lineHeight: 1,
    cursor: "pointer",
    transitionProperty: "background-color, border-color, transform, opacity",
    transitionDuration: motion.fast,
    transitionTimingFunction: motion.easeOut,
    ":hover": {
      backgroundColor: colors.panelRaised,
      borderColor: colors.lineHover,
    },
    ":active": {
      transform: "scale(0.96)",
    },
    ":disabled": {
      cursor: "not-allowed",
      opacity: 0.48,
      transform: "none",
    },
    "@media (max-width: 760px)": {
      minHeight: "44px",
    },
  },
  primary: {
    borderColor: colors.beam,
    backgroundColor: colors.beam,
    color: "oklch(18% 0.024 220)",
    ":hover": {
      borderColor: colors.focus,
      backgroundColor: colors.focus,
    },
  },
  quiet: {
    borderColor: "transparent",
    backgroundColor: "transparent",
    color: colors.muted,
  },
  iconOnly: {
    width: "40px",
    paddingInline: 0,
  },
  fullWidth: { width: "100%" },
  alignStart: { justifyContent: "flex-start" },
});

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly align?: "center" | "start";
  readonly children: ReactNode;
  readonly fullWidth?: boolean;
  readonly iconOnly?: boolean;
  readonly variant?: "default" | "primary" | "quiet";
};

export function Button({
  align = "center",
  children,
  fullWidth = false,
  iconOnly = false,
  type = "button",
  variant = "default",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      {...stylex.props(
        styles.button,
        variant === "primary" && styles.primary,
        variant === "quiet" && styles.quiet,
        iconOnly && styles.iconOnly,
        fullWidth && styles.fullWidth,
        align === "start" && styles.alignStart,
      )}
    >
      {children}
    </button>
  );
}
