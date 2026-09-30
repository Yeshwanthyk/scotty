import { Effect, Schema } from "effect";
import type * as Cloudflare from "alchemy/Cloudflare";
import type CredsObject from "../creds/object.js";
import type SessionObject from "../session/object.js";
import { fixtureRepo } from "../../protocol/supervisor.js";
import type { AgentKind, Origin } from "../session/events.js";
import type { PlaceKind } from "../places/place.js";
import { defaultBranch } from "./repository.js";

export const githubHint = "scotty login github";
export const Repo = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/));

// The first line of the prompt, cut at a word near 60 characters.
export const titleFrom = (prompt: string) => {
  const line = prompt.trim().split("\n")[0] ?? "";
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
};

export type StartInput = {
  repo: string;
  prompt: string;
  title: string;
  agent: typeof AgentKind.Type;
  // Where the container runs; hooks leave it to the default.
  place?: typeof PlaceKind.Type;
  scripted?: true;
  // With a key, a second start steers the session the first one made.
  key?: string;
  // Makes a retry a no-op: the session it reserved, or the steer it sent, the first time.
  retry: string;
  origin?: Origin;
};

// A start either makes a session, steers the one its key names, or says why not.
export function startSession(
  sessions: Cloudflare.DurableObject<SessionObject>,
  credential: ReturnType<Cloudflare.DurableObject<CredsObject>["getByName"]>,
  input: StartInput,
) {
  return Effect.gen(function* () {
    const steer = (known: { id: string; repo: string; agent: typeof AgentKind.Type }) =>
      Effect.gen(function* () {
        if (known.repo !== input.repo || known.agent !== input.agent)
          return { kind: "conflict" as const, id: known.id };
        const { status } = yield* sessions
          .getByName(known.id)
          .request({ kind: "prompt", req: input.retry, text: input.prompt });
        // A prompt the session refused (it failed, or its turn moved on) did not go in.
        return status === "pending" || status === "delivered"
          ? { kind: "steered" as const, id: known.id, status }
          : { kind: "unavailable" as const, id: known.id, status };
      });
    // The key is reserved before its session is made; a steer that arrives in between waits
    // for the session to exist, since a session that does not yet exist takes no prompt.
    const steerKeyed = (key: string) =>
      Effect.gen(function* () {
        let known = yield* credential.keyed(key);
        for (let waited = 0; known !== null && !known.created && waited < 40; waited++) {
          yield* Effect.sleep("250 millis");
          known = yield* credential.keyed(key);
        }
        return known === null ? null : yield* steer(known);
      });
    if (input.key !== undefined) {
      const steered = yield* steerKeyed(input.key);
      if (steered !== null) return steered;
    }
    const branch = yield* Effect.gen(function* () {
      if (input.repo === fixtureRepo) return { ok: true as const, branch: "main" };
      const token = yield* credential.gitHubToken();
      if (token === null) return { ok: false as const, message: "GitHub token missing" };
      return yield* defaultBranch(input.repo, token).pipe(
        Effect.map((found) => ({ ok: true as const, branch: found })),
        Effect.catchTag("RepositoryFailure", (error) =>
          Effect.succeed({ ok: false as const, message: error.message }),
        ),
      );
    });
    if (!branch.ok) return { kind: "refused" as const, message: branch.message, hint: githubHint };
    const baseBranch = branch.branch;
    const fresh = crypto.randomUUID().replaceAll("-", "");
    let id = fresh;
    if (input.key === undefined) id = yield* credential.reserve(input.retry, fresh);
    else {
      const reserved = yield* credential.reserveKey(input.key, fresh, input.repo, input.agent);
      if (!reserved.fresh) {
        const steered = yield* steerKeyed(input.key);
        if (steered !== null) return steered;
      }
    }
    const view = yield* sessions.getByName(id).create({
      id,
      repo: input.repo,
      baseBranch,
      title: input.title,
      prompt: input.prompt,
      agentKind: input.agent,
      image: "default",
      place: input.place ?? "cloudflare",
      ...(input.scripted === true ? { scripted: true } : {}),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    });
    if (input.key !== undefined) yield* credential.keyCreated(input.key);
    return { kind: "started" as const, id, view };
  });
}
