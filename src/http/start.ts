import { Effect, Schema } from "effect";
import type * as Cloudflare from "alchemy/Cloudflare";
import type CredsObject from "../creds/object.js";
import type SessionObject from "../session/object.js";
import { fixtureRepo } from "../../protocol/supervisor.js";
import type { AgentKind, Origin } from "../session/events.js";
import { defaultBranch } from "./repository.js";

export const githubHint = "scotty login github";
export const Repo = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/));

export type StartInput = {
  repo: string;
  prompt: string;
  title: string;
  agent: typeof AgentKind.Type;
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
        return { kind: "steered" as const, id: known.id, status };
      });
    if (input.key !== undefined) {
      const known = yield* credential.keyed(input.key);
      if (known !== null) return yield* steer(known);
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
      if (!reserved.fresh) return yield* steer(reserved);
    }
    const view = yield* sessions.getByName(id).create({
      id,
      repo: input.repo,
      baseBranch,
      title: input.title,
      prompt: input.prompt,
      agentKind: input.agent,
      image: "default",
      ...(input.scripted === true ? { scripted: true } : {}),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    });
    return { kind: "started" as const, id, view };
  });
}
