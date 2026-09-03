import { createFileRoute, useRouter } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import {
  AdminAppShell,
  AdminEmpty,
  AdminError,
  AdminPage,
  AdminRow,
  AdminRows,
  AdminSection,
  AdminStatus,
} from "../components/AdminPage";
import { Button } from "../components/Button";
import { readStats } from "../data/admin";
import { readSessionList } from "../data/session-list-reader";
import { sessionListFixtures } from "../fixtures/sessions";

export const Route = createFileRoute("/stats")({
  loader: ({ abortController }) =>
    Promise.all([
      readStats({ signal: abortController.signal }),
      readSessionList({
        fixture: sessionListFixtures,
        fixtureFallback: import.meta.env.DEV,
        signal: abortController.signal,
      }),
    ]).then(([stats, sessions]) => ({ sessions, stats })),
  component: StatsRoute,
});

const dateLabel = (value: string | null): string => {
  if (value === null) return "No retained history yet";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
};

function StatsRoute() {
  const { sessions, stats } = Route.useLoaderData();
  const router = useRouter();
  return (
    <AdminAppShell sessions={sessions} title="Stats">
      <AdminPage
        title="Stats"
        description={
          stats.ok
            ? `Workspace history tracked since ${dateLabel(stats.value.trackingSince)}.`
            : "Workspace history and current session totals."
        }
        action={
          <Button onClick={() => void router.invalidate()} variant="quiet">
            <RefreshCw aria-hidden width={15} height={15} />
            Refresh
          </Button>
        }
      >
        {stats.ok ? (
          <>
            <AdminSection title="Overview">
              <AdminRows>
                <AdminRow
                  title="Workspaces created"
                  aside={<AdminStatus>{stats.value.overall.workspacesCreated}</AdminStatus>}
                />
                <AdminRow
                  title="Projects"
                  aside={<AdminStatus>{stats.value.overall.projects}</AdminStatus>}
                />
                <AdminRow
                  title="Warm now"
                  aside={<AdminStatus tone="good">{stats.value.overall.warmNow}</AdminStatus>}
                />
                <AdminRow
                  title="Sleeping now"
                  aside={
                    <AdminStatus tone="warning">{stats.value.overall.sleepingNow}</AdminStatus>
                  }
                />
              </AdminRows>
            </AdminSection>
            <AdminSection
              title="Projects"
              description="Creation history grouped by repository, with current workspace state."
            >
              {stats.value.projects.length === 0 ? (
                <AdminEmpty>
                  New repositories appear after their first workspace is created.
                </AdminEmpty>
              ) : (
                <AdminRows>
                  {stats.value.projects.map((project) => (
                    <AdminRow
                      key={project.repository}
                      title={project.repository}
                      description={`Last created ${dateLabel(project.lastCreated)}`}
                      aside={
                        <>
                          <AdminStatus>{project.workspacesCreated} created</AdminStatus>
                          <AdminStatus tone="good">{project.warmNow} warm</AdminStatus>
                          <AdminStatus tone="warning">{project.sleepingNow} sleeping</AdminStatus>
                        </>
                      }
                    />
                  ))}
                </AdminRows>
              )}
            </AdminSection>
          </>
        ) : (
          <AdminError>{stats.failure.message}</AdminError>
        )}
      </AdminPage>
    </AdminAppShell>
  );
}
