import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { readSessionList, type SessionListReadResult } from "../data/session-list-reader";
import { buildSessionRail } from "../domain/session-rail";
import { sessionListFixtures } from "../fixtures/sessions";
import { colors, spacing } from "../theme/tokens.stylex";

export const Route = createFileRoute("/sessions")({
  loader: ({ abortController }): Promise<SessionListReadResult> =>
    readSessionList({
      fixture: sessionListFixtures,
      fixtureFallback: import.meta.env.DEV,
      signal: abortController.signal,
    }),
  component: SessionsHome,
});

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
  const result = Route.useLoaderData();
  const router = useRouter();
  const rail = buildSessionRail(result.ok ? result.projections.map(({ session }) => session) : []);
  return (
    <AppShell archivedSessions={rail.archivedSessions} repositories={rail.repositories}>
      <section {...stylex.props(styles.home)}>
        <div {...stylex.props(styles.content)}>
          <div>
            <h1 {...stylex.props(styles.heading)}>Sessions</h1>
            <p {...stylex.props(styles.intro)}>
              {result.ok ? "Select a session or create one." : "Sessions could not be loaded."}
            </p>
            {result.ok ? null : <Button onClick={() => void router.invalidate()}>Try again</Button>}
          </div>
        </div>
      </section>
    </AppShell>
  );
}
