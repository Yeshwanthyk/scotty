import { createFileRoute } from "@tanstack/react-router";
import { AutomationsPage } from "../components/Automations";

export const Route = createFileRoute("/automations/$name")({ component: Automation });

function Automation() {
  const { name } = Route.useParams();
  return <AutomationsPage name={name} />;
}
