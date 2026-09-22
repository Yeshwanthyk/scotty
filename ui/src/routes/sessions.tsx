import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { createContext } from "react";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { SessionRow, type SessionRowProps } from "../components/SessionRow";
import { useSessionCatalog } from "../data/session-catalog";
import { colors, spacing } from "../theme/tokens.stylex";
import scottyHero from "../../../worker/public/brand/scotty-hero-16x9.png?url";

export const RecentRepositoriesContext = createContext<ReadonlyArray<string>>([]);

export const Route = createFileRoute("/sessions")({
  component: SessionsHome,
});

const styles = stylex.create({
  home: {
    minHeight: "100dvh",
    padding: "44px clamp(28px, 7vw, 88px) 64px",
    backgroundColor: colors.space,
    "@media (max-width: 760px)": {
      minHeight: "calc(100dvh - 52px)",
      padding: "20px 16px 40px",
    },
  },
  content: {
    width: "min(840px, 100%)",
    marginInline: "auto",
    display: "grid",
    gap: spacing.xxl,
  },
  welcome: {
    minHeight: "220px",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 300px",
    gridTemplateAreas: '"copy art"',
    alignItems: "center",
    gap: "clamp(32px, 6vw, 72px)",
    "@media (max-width: 680px)": {
      minHeight: 0,
      gridTemplateColumns: "1fr",
      gridTemplateAreas: '"art" "copy"',
      gap: spacing.lg,
    },
  },
  welcomeCopy: { gridArea: "copy", display: "grid", justifyItems: "start", gap: spacing.md },
  heading: {
    margin: 0,
    color: colors.ink,
    fontSize: "28px",
    fontWeight: 700,
    lineHeight: 1.15,
    letterSpacing: "-0.03em",
    textWrap: "balance",
    "@media (max-width: 680px)": { fontSize: "24px" },
  },
  intro: {
    maxWidth: "42ch",
    margin: 0,
    color: colors.muted,
    fontSize: "14px",
    lineHeight: 1.55,
  },
  artwork: {
    gridArea: "art",
    width: "100%",
    height: "220px",
    display: "block",
    objectFit: "cover",
    objectPosition: "center",
    opacity: 0.9,
    maskImage: "linear-gradient(90deg, transparent 0%, black 22%, black 100%)",
    "@media (max-width: 680px)": {
      height: "148px",
      objectPosition: "center 56%",
      maskImage: "linear-gradient(90deg, transparent 0%, black 12%, black 88%, transparent 100%)",
    },
  },
  create: {
    minHeight: "40px",
    paddingInline: spacing.md,
    display: "inline-flex",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: "8px",
    backgroundColor: colors.beam,
    color: colors.space,
    fontSize: "13px",
    fontWeight: 600,
    textDecoration: "none",
    ":hover": { backgroundColor: colors.focus },
    ":focus-visible": { outline: `2px solid ${colors.focus}`, outlineOffset: "2px" },
    "@media (max-width: 760px)": { minHeight: "44px" },
  },
  createIcon: { width: "15px", height: "15px", strokeWidth: 1.8 },
  sessions: { width: "min(620px, 100%)", display: "grid", gap: spacing.sm },
  sessionsHeading: {
    margin: 0,
    color: colors.muted,
    fontSize: "12px",
    fontWeight: 620,
    lineHeight: 1.4,
  },
  sessionList: { display: "grid", gap: "2px" },
  stateMessage: { margin: 0, color: colors.muted, fontSize: "13px", lineHeight: 1.55 },
  errorActions: { display: "flex", alignItems: "center", gap: spacing.sm },
});

const landingSessions = (
  sessionIds: ReadonlyArray<string>,
  rail: ReturnType<typeof useSessionCatalog>["rail"],
): ReadonlyArray<SessionRowProps> => {
  const rows = new Map(
    [...rail.repositories.flatMap(({ sessions }) => sessions), ...rail.archivedSessions].map(
      (row) => [row.session.id, row],
    ),
  );
  return sessionIds.flatMap((sessionId) => {
    const row = rows.get(sessionId);
    return row === undefined ? [] : [row];
  });
};

function SessionsHome() {
  const catalog = useSessionCatalog();
  const matchRoute = useMatchRoute();
  const createRouteActive = matchRoute({ to: "/sessions/create", fuzzy: false }) !== false;
  const recentRepositories = [
    ...new Set(catalog.sessions.map((session) => session.display.repository)),
  ];
  const recentSessions = landingSessions(
    catalog.sessions.map((session) => session.id),
    catalog.rail,
  ).slice(0, 5);
  return (
    <RecentRepositoriesContext value={recentRepositories}>
      <AppShell mobileTitle={createRouteActive ? undefined : "Scotty"}>
        {createRouteActive ? (
          <Outlet />
        ) : (
          <section {...stylex.props(styles.home)}>
            <div {...stylex.props(styles.content)}>
              <div {...stylex.props(styles.welcome)}>
                <div {...stylex.props(styles.welcomeCopy)}>
                  <h1 {...stylex.props(styles.heading)}>What shall we work on?</h1>
                  <p {...stylex.props(styles.intro)}>
                    Start something new or return to a recent session.
                  </p>
                  {catalog.status !== "degraded" || catalog.sessions.length > 0 ? (
                    <Link to="/sessions/create" {...stylex.props(styles.create)}>
                      <Plus aria-hidden {...stylex.props(styles.createIcon)} />
                      New session
                    </Link>
                  ) : null}
                </div>
                <img src={scottyHero} alt="" {...stylex.props(styles.artwork)} />
              </div>

              <section aria-labelledby="recent-sessions-heading" {...stylex.props(styles.sessions)}>
                <h2 id="recent-sessions-heading" {...stylex.props(styles.sessionsHeading)}>
                  Recent sessions
                </h2>
                {catalog.status === "loading" ? (
                  <p role="status" {...stylex.props(styles.stateMessage)}>
                    Loading sessions…
                  </p>
                ) : recentSessions.length ? (
                  <>
                    {catalog.status === "degraded" ? (
                      <p role="status" {...stylex.props(styles.stateMessage)}>
                        Showing the last verified session list while Scotty reconnects.
                      </p>
                    ) : null}
                    <div {...stylex.props(styles.sessionList)}>
                      {recentSessions.map((session) => (
                        <SessionRow key={session.session.id} {...session} variant="landing" />
                      ))}
                    </div>
                  </>
                ) : catalog.status === "ready" ? (
                  <p {...stylex.props(styles.stateMessage)}>
                    No sessions yet. Start with a repository and a task.
                  </p>
                ) : (
                  <div {...stylex.props(styles.errorActions)}>
                    <p {...stylex.props(styles.stateMessage)}>Sessions could not be loaded.</p>
                    <Button onClick={() => void catalog.refresh()}>Try again</Button>
                  </div>
                )}
              </section>
            </div>
          </section>
        )}
      </AppShell>
    </RecentRepositoriesContext>
  );
}
