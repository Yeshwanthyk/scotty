import { createFileRoute, Navigate } from "@tanstack/react-router";
import { isSection, SettingsPage } from "../components/Settings";

export const Route = createFileRoute("/settings/$section")({ component: Section });

function Section() {
  const { section } = Route.useParams();
  return isSection(section) ? <SettingsPage section={section} /> : <Navigate to="/settings" />;
}
