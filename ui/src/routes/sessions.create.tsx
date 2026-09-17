import { createFileRoute } from "@tanstack/react-router";
import { useContext } from "react";
import { CreateSessionForm } from "../components/CreateSessionForm";
import { RecentRepositoriesContext } from "./sessions";

export const Route = createFileRoute("/sessions/create")({
  component: CreateSessionRoute,
});

function CreateSessionRoute() {
  const recentRepositories = useContext(RecentRepositoriesContext);
  return <CreateSessionForm recentRepositories={recentRepositories} />;
}
