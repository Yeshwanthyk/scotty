import { Option, Schema } from "effect";
import { request } from "./core";
import { Stats, type StatsWindow } from "../../../src/session/stats";

export type { RepoStats, Stats, StatsWindow } from "../../../src/session/stats";

const decodeStats = Schema.decodeUnknownOption(Stats);

export async function stats(window: StatsWindow, signal?: AbortSignal): Promise<Stats> {
  const result = Option.getOrUndefined(
    decodeStats(await request(`/api/stats?window=${window}`, undefined, signal)),
  );
  if (result === undefined) throw new Error("Unreadable stats");
  return result;
}
