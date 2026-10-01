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
export const Prompt = Schema.String.check(
  Schema.makeFilter((text) => text.trim() !== "", { expected: "a prompt that is not blank" }),
  Schema.isMaxLength(256 * 1024),
  Schema.makeFilter((text) => new TextEncoder().encode(text).byteLength <= 256 * 1024, {
    expected: "at most 256 KiB of UTF-8 text",
  }),
);

export type StartInput = {
  repo: string;
  prompt: string;
  title: string;
  agent: typeof AgentKind.Type;
  // Where the container runs; hooks leave it to the default.
  place?: typeof PlaceKind.Type;
  scripted?: true;
  // An automation run reserves its target before dispatch, so retries keep that session.
  id?: string;
  branch?: string;
  // With a key, a second start steers the session the first one made.
  key?: string;
  // The request id: a retry with it is answered with what the first attempt did.
  retry: string;
  origin?: Origin;
};

// A start makes a session, prompts the one its key names, answers a retry with what the first
// attempt did, or says why not. The Session DO decides which; every caller with one id agrees.
export function startSession(
  sessions: Cloudflare.DurableObject<SessionObject>,
  credential: ReturnType<Cloudflare.DurableObject<CredsObject>["getByName"]>,
  input: StartInput,
) {
  return Effect.gen(function* () {
    const request = {
      req: input.retry,
      prompt: input.prompt,
      repo: input.repo,
      agentKind: input.agent,
    };
    // Automations already resolved their target; a made session needs no repository lookup.
    const keyed =
      input.id ??
      (input.origin?.kind === "automation" || input.key === undefined
        ? null
        : yield* credential.keyed(input.key));
    if (keyed !== null) {
      const answer = yield* sessions.getByName(keyed).start(request);
      if (answer.kind !== "uncreated") return { ...answer, id: keyed };
    }
    const branch = yield* Effect.gen(function* () {
      if (input.branch !== undefined) return { ok: true as const, branch: input.branch };
      if (input.repo === fixtureRepo) return { ok: true as const, branch: "main" };
      const token = yield* credential.gitHubToken();
      if (token === null)
        return {
          ok: false as const,
          code: "repository_unavailable" as const,
          message: "GitHub token missing",
        };
      return yield* defaultBranch(input.repo, token).pipe(
        Effect.map((found) => ({ ok: true as const, branch: found })),
        Effect.catchTag("RepositoryFailure", (error) =>
          Effect.succeed({
            ok: false as const,
            code:
              error.missing === true
                ? ("repository_not_found" as const)
                : ("repository_unavailable" as const),
            message: error.message,
          }),
        ),
      );
    });
    if (!branch.ok)
      return {
        kind: "refused" as const,
        code: branch.code,
        message: branch.message,
        hint: githubHint,
      };
    const id =
      input.id ??
      (yield* credential.reserve({
        req: input.retry,
        ...(input.key === undefined ? {} : { key: input.key }),
        id: crypto.randomUUID().replaceAll("-", ""),
        title: input.title,
        repo: input.repo,
        prompt: input.prompt,
        ...(input.origin?.kind === "hook" ? { connection: input.origin.connection } : {}),
        ...(input.origin?.kind === "automation"
          ? { automation: input.origin.automation, run: input.origin.run }
          : {}),
      }));
    const answer = yield* sessions.getByName(id).start({
      ...request,
      create: {
        id,
        baseBranch: branch.branch,
        title: input.title,
        image: "default",
        place: input.place ?? "cloudflare",
        ...(input.scripted === true ? { scripted: true } : {}),
        ...(input.origin === undefined ? {} : { origin: input.origin }),
      },
    });
    // With `create` given, the session is never left unmade.
    return answer.kind === "uncreated"
      ? yield* Effect.die("Session was not created")
      : { ...answer, id };
  });
}
