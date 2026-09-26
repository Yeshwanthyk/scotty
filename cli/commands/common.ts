import { Effect, Option } from "effect";
import { Flag } from "effect/unstable/cli";
import { access, client, failure, target } from "../client.js";

export const url = Flag.String("url").pipe(Flag.optional);
export const output = (value: unknown) =>
  Effect.sync(() => {
    console.log(JSON.stringify(value));
  });
export const withClient = (override: Option.Option<string>) =>
  Effect.gen(function* () {
    const address = yield* target(Option.getOrElse(override, () => process.env.SCOTTY_URL ?? ""));
    return client({ url: address, token: yield* access(address) });
  });
export const usage = (message: string, command: string) =>
  failure("usage", message, `scotty ${command} --help`, 2);
export const sessionPath = (id: string) => {
  if (!/^[a-z0-9-]{6,32}$/.test(id))
    throw usage("Session id must be 6–32 lowercase letters, digits or hyphens", "show");
  return `/api/sessions/${id}`;
};
export const turnFrom = (log: readonly { kind: string; data?: unknown }[]) => {
  let turn = "0";
  for (const event of log) {
    if (event.kind === "turn.ended") turn = String(Number(turn) + 1);
  }
  return turn;
};
