import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { SourceFailure, type SourceSpec } from "../settings/skills.js";

const headers = (token: string, accept: string) => ({
  accept,
  authorization: `Bearer ${token}`,
  "user-agent": "scotty-rebuild",
});

const Repository = Schema.Struct({ default_branch: Schema.String.check(Schema.isMinLength(1)) });
class RepositoryFailure extends Schema.TaggedError<RepositoryFailure>()("RepositoryFailure", {
  message: Schema.String,
  missing: Schema.optionalKey(Schema.Literal(true)),
}) {}

const Catalog = Schema.Array(
  Schema.Struct({
    full_name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  }),
);
export const repositories = (page: number, perPage: number, token: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get("https://api.github.com/user/repos").pipe(
          HttpClientRequest.setHeaders(headers(token, "application/vnd.github+json")),
          HttpClientRequest.setUrlParams({
            page,
            per_page: perPage,
            sort: "full_name",
            direction: "asc",
          }),
        ),
      )
      .pipe(
        Effect.mapError(
          () => new RepositoryFailure({ message: "GitHub repositories unavailable" }),
        ),
      );
    if (response.status !== 200)
      return yield* new RepositoryFailure({
        message: `GitHub repositories returned HTTP ${response.status}`,
      });
    const body = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Catalog)),
      Effect.mapError(
        () => new RepositoryFailure({ message: "Invalid GitHub repository catalog" }),
      ),
    );
    return {
      repos: body.map((repo) => repo.full_name),
      nextPage: /rel="next"/.test(response.headers.link ?? "") ? page + 1 : null,
    };
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer));

/** The default branch of a repository the token can reach. */
export const defaultBranch = (repo: string, token: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`https://api.github.com/repos/${repo}`, {
          headers: headers(token, "application/vnd.github+json"),
        }),
      catch: () => new RepositoryFailure({ message: "GitHub repository lookup unavailable" }),
    });
    if (!response.ok)
      return yield* new RepositoryFailure({
        message: `GitHub repository lookup returned HTTP ${response.status}`,
        ...(response.status === 404 ? { missing: true as const } : {}),
      });
    const json: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new RepositoryFailure({ message: "Invalid GitHub repository response" }),
    });
    const decoded = yield* Schema.decodeUnknownEffect(Repository)(json).pipe(
      Effect.mapError(
        () => new RepositoryFailure({ message: "Invalid GitHub repository response" }),
      ),
    );
    return decoded.default_branch;
  });

export const resolveCommit = (source: SourceSpec, token: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(
          `https://api.github.com/repos/${source.repo}/commits/${encodeURIComponent(source.ref ?? "HEAD")}`,
          { headers: headers(token, "application/vnd.github.sha") },
        ),
      catch: () => new SourceFailure({ message: "GitHub is unreachable" }),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new SourceFailure({ message: "GitHub's answer was cut off" }),
    });
    if (response.status === 404 || response.status === 422)
      return yield* new SourceFailure({
        message: `GitHub has no ${source.repo}${source.ref === null ? "" : `@${source.ref}`} this token can see`,
        status: 404,
      });
    if (!response.ok || !/^[0-9a-f]{40}$/.test(text.trim()))
      return yield* new SourceFailure({ message: `GitHub answered HTTP ${response.status}` });
    return text.trim();
  });

export const tarball = (repo: string, commit: string, token: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`https://api.github.com/repos/${repo}/tarball/${commit}`, {
          headers: headers(token, "application/vnd.github+json"),
        }),
      catch: () => new SourceFailure({ message: "GitHub is unreachable" }),
    });
    if (!response.ok || response.body === null)
      return yield* new SourceFailure({
        message: `GitHub answered HTTP ${response.status} for the tarball`,
      });
    return response.body;
  });

const origins = { git: "https://github.com", api: "https://api.github.com" } as const;

export type ProxyRequest = {
  target: keyof typeof origins;
  path: string;
  method: string;
  headers: ReadonlyArray<readonly [string, string]>;
  body: ReadableStream<Uint8Array> | ArrayBuffer | null;
};

class ProxyFailure extends Schema.TaggedError<ProxyFailure>()("ProxyFailure", {
  reason: Schema.Literals(["bad_path", "unreachable"]),
}) {}

/** Sends a session's GitHub request with the token added; the answer streams back untouched. */
export const proxy = (input: ProxyRequest, token: string) =>
  Effect.gen(function* () {
    const origin = origins[input.target];
    const url = yield* Effect.try({
      try: () => new URL(`${origin}${input.path}`),
      catch: () => new ProxyFailure({ reason: "bad_path" }),
    });
    if (url.origin !== origin || !input.path.startsWith("/"))
      return yield* new ProxyFailure({ reason: "bad_path" });
    const sent = new Headers(input.headers.map(([name, value]) => [name, value]));
    sent.set(
      "authorization",
      input.target === "git" ? `Basic ${btoa(`x-access-token:${token}`)}` : `Bearer ${token}`,
    );
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: input.method,
          headers: sent,
          body: input.body,
          ...(input.target === "api" ? { redirect: "manual" as const } : {}),
        }),
      catch: () => new ProxyFailure({ reason: "unreachable" }),
    });
    return {
      kind: "response" as const,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
      body: response.body,
    };
  }).pipe(Effect.catchTag("ProxyFailure", (error) => Effect.succeed({ kind: error.reason })));

/** The Worker's side: GitHub's answer from `proxy` as a Response to stream to the session. */
export const proxied = (answer: {
  status: number;
  statusText: string;
  headers: ReadonlyArray<readonly [string, string]>;
  body: ReadableStream<Uint8Array> | null;
}) =>
  new Response(answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers: answer.headers.map(([name, value]) => [name, value]),
  });
