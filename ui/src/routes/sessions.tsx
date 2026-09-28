import { createFileRoute, Outlet, useMatchRoute } from "@tanstack/react-router";
import { NewSession } from "../components/NewSession";

export const Route = createFileRoute("/sessions")({ component: Sessions });

// The phone shows the session list here (the sidebar, full screen); the desktop starts a session.
function Sessions() {
  const creating = useMatchRoute()({ to: "/sessions/create", fuzzy: false }) !== false;
  return creating ? <Outlet /> : <NewSession />;
}
