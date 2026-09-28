import { createFileRoute } from "@tanstack/react-router";
import { NewSession } from "../components/NewSession";

export const Route = createFileRoute("/sessions/create")({ component: NewSession });
