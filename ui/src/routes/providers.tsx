import { createFileRoute, useRouter } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
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
import {
  readCurrentPrincipal,
  readProviders,
  readRunners,
  runRunnerAction,
  type RunnerAction,
  type RunnerStatus,
} from "../data/admin";
import { readSessionList } from "../data/session-list-reader";
import { sessionListFixtures } from "../fixtures/sessions";

export const Route = createFileRoute("/providers")({
  loader: async ({ abortController }) => {
    const options = { signal: abortController.signal };
    const [principal, sessions] = await Promise.all([
      readCurrentPrincipal(options),
      readSessionList({
        fixture: sessionListFixtures,
        fixtureFallback: import.meta.env.DEV,
        signal: abortController.signal,
      }),
    ]);
    if (!principal.ok || principal.value.role !== "owner")
      return { principal, providers: null, runners: null, sessions };
    const [providers, runners] = await Promise.all([readProviders(options), readRunners(options)]);
    return { principal, providers, runners, sessions };
  },
  component: ProvidersRoute,
});

const providerDescription = (name: "cloudflare" | "runner"): string =>
  name === "cloudflare"
    ? "Cloud workspaces managed by the deployment control plane."
    : "Named machines available for portable session execution.";

const dateTimeLabel = (value: string | null): string =>
  value === null
    ? "Never connected"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      );

const actionsFor = (runner: RunnerStatus): ReadonlyArray<RunnerAction> => {
  const actions: RunnerAction[] = [];
  if (runner.desired === "accepting") actions.push("drain");
  else actions.push("enable");
  if (runner.desired !== "disabled") actions.push("disable");
  if (runner.connection === "connected") actions.push("disconnect");
  return actions;
};

function ProvidersRoute() {
  const { principal, providers, runners, sessions } = Route.useLoaderData();
  const router = useRouter();
  const [busyRunner, setBusyRunner] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const runAction = (runner: RunnerStatus, action: RunnerAction): void => {
    if (busyRunner !== null) return;
    setBusyRunner(runner.name);
    setActionError(null);
    void runRunnerAction(runner.name, action)
      .then(async (result) => {
        if (!result.ok) {
          setActionError(result.failure.message);
          return;
        }
        await router.invalidate();
      })
      .finally(() => setBusyRunner(null));
  };

  return (
    <AdminAppShell sessions={sessions} title="Providers">
      <AdminPage
        title="Providers & runners"
        description="Execution availability and controls for named runner machines."
        action={
          <Button onClick={() => void router.invalidate()} variant="quiet">
            <RefreshCw aria-hidden width={15} height={15} />
            Refresh
          </Button>
        }
      >
        {actionError === null ? null : <AdminError>{actionError}</AdminError>}
        {!principal.ok ? (
          <AdminError>{principal.failure.message}</AdminError>
        ) : principal.value.role !== "owner" || providers === null || runners === null ? (
          <AdminError>Open this page from the primary device to manage providers.</AdminError>
        ) : (
          <>
            <AdminSection
              title="Providers"
              description="Session placement uses these execution types."
            >
              {providers.ok ? (
                <AdminRows>
                  {providers.value.map((provider) => (
                    <AdminRow
                      key={provider.name}
                      title={provider.name === "cloudflare" ? "Cloudflare" : "Runner"}
                      description={providerDescription(provider.name)}
                      aside={
                        <AdminStatus
                          tone={
                            provider.status === "unavailable"
                              ? "warning"
                              : provider.status === "available"
                                ? "good"
                                : "neutral"
                          }
                        >
                          {provider.status}
                        </AdminStatus>
                      }
                    />
                  ))}
                </AdminRows>
              ) : (
                <AdminError>{providers.failure.message}</AdminError>
              )}
            </AdminSection>
            <AdminSection
              title="Runners"
              description="Enable admission, drain new work, or disconnect a registered machine."
            >
              {runners.ok ? (
                runners.value.length === 0 ? (
                  <AdminEmpty>No runner is configured for this deployment.</AdminEmpty>
                ) : (
                  <AdminRows>
                    {runners.value.map((runner) => (
                      <AdminRow
                        key={runner.name}
                        title={runner.name}
                        description={`${runner.assignedSessions} assigned · last seen ${dateTimeLabel(runner.lastSeenAt)}`}
                        aside={
                          <>
                            <AdminStatus
                              tone={runner.connection === "connected" ? "good" : "warning"}
                            >
                              {runner.connection}
                            </AdminStatus>
                            <AdminStatus>{runner.desired}</AdminStatus>
                            {actionsFor(runner).map((action) => (
                              <Button
                                key={action}
                                disabled={busyRunner !== null}
                                onClick={() => runAction(runner, action)}
                                variant="quiet"
                              >
                                {busyRunner === runner.name ? "Working…" : action}
                              </Button>
                            ))}
                          </>
                        }
                      />
                    ))}
                  </AdminRows>
                )
              ) : (
                <AdminError>{runners.failure.message}</AdminError>
              )}
            </AdminSection>
          </>
        )}
      </AdminPage>
    </AdminAppShell>
  );
}
