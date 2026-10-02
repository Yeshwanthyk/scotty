import { Schema } from "effect";
import { request } from "./core";
import { automations } from "./automations";
import { addConnection, connections } from "./settings";
import { Blueprint, installation, taken, type Choices } from "../../../src/blueprints/blueprint";
import prReviewer from "../../../blueprints/pr-reviewer.json";
import linear from "../../../blueprints/linear.json";

export type { Blueprint };
export const blueprints: ReadonlyArray<Blueprint> = [prReviewer, linear].map((data) =>
  Schema.decodeUnknownSync(Blueprint)(data),
);

// Everything is checked, then created off; a name already in use stops it before anything is made.
export async function installBlueprint(blueprint: Blueprint, choices: Choices) {
  const plan = installation(blueprint, choices);
  if (!plan.ok) throw new Error(plan.problem);
  const [existing, current] = await Promise.all([connections(), automations()]);
  const clash = taken(plan.installation, {
    connections: existing.map((connection) => connection.name),
    automations: current.map((automation) => automation.name),
  });
  if (clash.length > 0) throw new Error(`Already exists: ${clash.join(", ")}`);
  const created = [];
  for (const connection of plan.installation.connections)
    created.push(await addConnection(connection));
  for (const automation of plan.installation.automations)
    await request("/api/automations", automation);
  return created;
}
