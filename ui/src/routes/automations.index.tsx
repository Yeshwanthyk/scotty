import { createFileRoute } from "@tanstack/react-router";
import { AutomationsPage } from "../components/Automations";

export const Route = createFileRoute("/automations/")({ component: () => <AutomationsPage /> });
