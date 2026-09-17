import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link, Outlet, useMatchRoute, useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { createContext, useEffect, useState } from "react";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { readSessionList, type SessionListReadResult } from "../data/session-list-reader";
import { buildSessionRail } from "../domain/session-rail";
import { sessionListFixtures } from "../fixtures/sessions";
import { colors, spacing } from "../theme/tokens.stylex";

export const RecentRepositoriesContext = createContext<ReadonlyArray<string>>([]);

export const beginSessionListRead = (
  signal: AbortSignal,
  read: typeof readSessionList = readSessionList,
) => ({
  sessionList: read({
    fixture: sessionListFixtures,
    fixtureFallback: import.meta.env.DEV,
    signal,
  }),
});

export const Route = createFileRoute("/sessions")({
  loader: ({ abortController }) => beginSessionListRead(abortController.signal),
  component: SessionsHome,
});

const styles = stylex.create({
  home: {
    minHeight: "100dvh",
    paddingBlock: "clamp(32px, 7vh, 72px)",
    paddingInline: "clamp(28px, 7vw, 104px)",
    display: "grid",
    alignContent: "start",
    backgroundColor: colors.space,
  },
  content: { width: "min(680px, 100%)", display: "grid", gap: spacing.lg },
  headingRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.lg,
  },
  heading: {
    maxWidth: "650px",
    margin: 0,
    color: colors.ink,
    fontSize: "22px",
    fontWeight: 680,
    lineHeight: 1.2,
    letterSpacing: "-0.025em",
  },
  intro: {
    margin: `${spacing.md} 0 0`,
    maxWidth: "560px",
    color: colors.muted,
    fontSize: "14px",
    lineHeight: 1.6,
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
});

function SessionsHome() {
  const { sessionList } = Route.useLoaderData();
  const [result, setResult] = useState<SessionListReadResult>();
  const router = useRouter();
  const matchRoute = useMatchRoute();
  const createRouteActive = matchRoute({ to: "/sessions/create", fuzzy: false }) !== false;
  useEffect(() => {
    let current = true;
    void sessionList.then((nextResult) => {
      if (current) setResult(nextResult);
    });
    return () => {
      current = false;
    };
  }, [sessionList]);
  const rail = buildSessionRail(result?.ok ? result.projections.map(({ session }) => session) : []);
  const recentRepositories = result?.ok
    ? [...new Set(result.projections.map(({ session }) => session.display.repository))]
    : [];
  return (
    <RecentRepositoriesContext value={recentRepositories}>
      <AppShell archivedSessions={rail.archivedSessions} repositories={rail.repositories}>
        {createRouteActive ? (
          <Outlet />
        ) : (
          <section {...stylex.props(styles.home)}>
            <div {...stylex.props(styles.content)}>
              <div>
                <div {...stylex.props(styles.headingRow)}>
                  <h1 {...stylex.props(styles.heading)}>Sessions</h1>
                  {result === undefined || result.ok ? (
                    <Link to="/sessions/create" {...stylex.props(styles.create)}>
                      <Plus aria-hidden {...stylex.props(styles.createIcon)} />
                      New session
                    </Link>
                  ) : null}
                </div>
                <p {...stylex.props(styles.intro)}>
                  {result === undefined
                    ? "Loading sessions…"
                    : result.ok
                      ? "Select a session or create one."
                      : "Sessions could not be loaded."}
                </p>
                {result === undefined || result.ok ? null : (
                  <Button onClick={() => void router.invalidate()}>Try again</Button>
                )}
              </div>
            </div>
          </section>
        )}
      </AppShell>
    </RecentRepositoriesContext>
  );
}
