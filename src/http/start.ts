import type { PromptImage } from "../../protocol/prompt.js";
import { Effect, Schema } from "effect";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import type CredsObject from "../creds/object.js";
import type SessionObject from "../session/object.js";
import { fixtureRepo } from "../../protocol/supervisor.js";
import type { AgentKind, Origin } from "../session/events.js";
import type { PlaceKind, Size } from "../places/place.js";

export const githubHint = "scotty login github";
export const Repo = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/));
export const repoKey = (repo: string) => repo.toLowerCase();
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
  images?: readonly PromptImage[];
  title: string;
  agent: typeof AgentKind.Type;
  place?: typeof PlaceKind.Type;
  size?: typeof Size.Type;
  scripted?: true;
  idleAfter?: number;
  id?: string;
  branch?: string;
  key?: string;
  retry: string;
  origin?: Origin;
};

export function startSession(
  sessions: Cloudflare.DurableObject<SessionObject>,
  credential: ReturnType<Cloudflare.DurableObject<CredsObject>["getByName"]>,
  input: StartInput,
) {
  return Effect.gen(function* () {
    const request = {
      req: input.retry,
      prompt: input.prompt,
      images: input.images ?? [],
      repo: input.repo,
      agentKind: input.agent,
    };
    const keyed = input.id ?? (yield* credential.resolveSession(input.retry, input.key ?? null));
    if (keyed !== null) {
      const answer = yield* sessions.getByName(keyed).start(request);
      if (answer.kind !== "uncreated") return { ...answer, id: keyed };
    }
    const branch = yield* Effect.gen(function* () {
      if (input.branch !== undefined) return { ok: true as const, branch: input.branch };
      if (input.repo === fixtureRepo) return { ok: true as const, branch: "main" };
      const found = yield* credential.defaultBranch(input.repo);
      if (found.status === "found") return { ok: true as const, branch: found.branch };
      if (found.status === "signed-out")
        return {
          ok: false as const,
          code: "repository_unavailable" as const,
          message: "GitHub token missing",
        };
      return {
        ok: false as const,
        code: found.missing
          ? ("repository_not_found" as const)
          : ("repository_unavailable" as const),
        message: found.message,
      };
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
    const repoSize = input.size === undefined ? yield* credential.repoSize(input.repo) : null;
    const answer = yield* sessions.getByName(id).start({
      ...request,
      ...(input.size === undefined ? {} : { size: input.size }),
      create: {
        ...(repoSize === null ? {} : { repoSize }),
        id,
        baseBranch: branch.branch,
        title: input.title,
        image: "default",
        place: input.place ?? "cloudflare",
        ...(input.scripted === true ? { scripted: true } : {}),
        ...(input.idleAfter === undefined ? {} : { idleAfter: input.idleAfter }),
        ...(input.origin === undefined ? {} : { origin: input.origin }),
      },
    });
    return answer.kind === "uncreated"
      ? yield* Effect.die("Session was not created")
      : { ...answer, id };
  });
}
