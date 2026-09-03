import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "../components/AppShell";
import { buildFixtureSessionRail } from "../domain/session-rail";
import { colors, spacing } from "../theme/tokens.stylex";

export const Route = createFileRoute("/sessions")({ component: SessionsHome });

const rail = buildFixtureSessionRail();
const styles = stylex.create({
  home: {
    minHeight: "100dvh",
    paddingBlock: "clamp(48px, 10vh, 112px)",
    paddingInline: "clamp(28px, 7vw, 104px)",
    display: "grid",
    alignContent: "start",
    backgroundColor: colors.space,
  },
  content: { width: "min(680px, 100%)", display: "grid", gap: spacing.xl },
  heading: {
    maxWidth: "650px",
    margin: 0,
    color: colors.ink,
    fontSize: "clamp(26px, 4vw, 40px)",
    fontWeight: 720,
    lineHeight: 1.02,
    letterSpacing: "-0.045em",
  },
  intro: {
    margin: `${spacing.md} 0 0`,
    maxWidth: "560px",
    color: colors.muted,
    fontSize: "16px",
    lineHeight: 1.6,
  },
});

function SessionsHome() {
  return (
    <AppShell archivedSessions={rail.archivedSessions} repositories={rail.repositories}>
      <section {...stylex.props(styles.home)}>
        <div {...stylex.props(styles.content)}>
          <div>
            <h1 {...stylex.props(styles.heading)}>Sessions</h1>
            <p {...stylex.props(styles.intro)}>Select a session or create one.</p>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
