import { createFileRoute } from "@tanstack/react-router";
import { StatsPage } from "../components/Stats";

export const Route = createFileRoute("/stats")({ component: () => <StatsPage /> });
