import { createFileRoute } from "@tanstack/react-router";
import { CreateSessionForm } from "../components/CreateSessionForm";

export const Route = createFileRoute("/sessions/create")({
  component: CreateSessionRoute,
});

function CreateSessionRoute() {
  return <CreateSessionForm />;
}
