import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { CreateSessionForm } from "../components/CreateSessionForm";

export const Route = createFileRoute("/sessions/create")({
  component: CreateSessionRoute,
});

function CreateSessionRoute() {
  const sessions = getRouteApi("/sessions").useLoaderData();
  const recentRepositories = sessions.ok
    ? [...new Set(sessions.projections.map(({ session }) => session.display.repository))]
    : [];
  return <CreateSessionForm recentRepositories={recentRepositories} />;
}
