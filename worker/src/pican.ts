import { Result, Schema } from "effect";
import { sessionRoot } from "./workspace";

const PicanCreateResponseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  nativeId: Schema.NonEmptyString,
  runtime: Schema.Literal("codex"),
  createState: Schema.Literals(["created", "creating", "unknown"]),
  promptDispatchState: Schema.Literals(["accepted", "not_requested", "dispatching", "unknown"]),
});
type PicanCreateResponse = typeof PicanCreateResponseSchema.Type;
const decodePicanCreateResponseJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(PicanCreateResponseSchema),
);
const PicanBootstrapResponseSchema = Schema.Struct({
  defaultBranch: Schema.NonEmptyString,
  repoExists: Schema.Boolean,
});
export type PicanBootstrapResponse = typeof PicanBootstrapResponseSchema.Type;
export const decodePicanBootstrapResponseJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(PicanBootstrapResponseSchema),
);
const PicanWorkerStatusSchema = Schema.Struct({
  state: Schema.Literals(["idle", "running", "error"]),
});
export type PicanWorkerStatus = typeof PicanWorkerStatusSchema.Type;
export const decodePicanWorkerStatusJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(PicanWorkerStatusSchema),
);

export type PicanCreateResult =
  | ({ readonly state: "pending" } & PicanCreateResponse)
  | ({ readonly state: "stable" } & PicanCreateResponse)
  | ({ readonly state: "unknown" } & PicanCreateResponse)
  | { readonly state: "conflict" }
  | { readonly state: "invalid" };

export function picanCreateRequest(origin: string, id: string, prompt?: string): Request {
  const body =
    prompt === undefined
      ? { path: sessionRoot(id), runtime: "codex" }
      : { path: sessionRoot(id), runtime: "codex", initialPrompt: prompt };
  return new Request(`${origin}/s/${id}/api/new-session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": id,
    },
    body: JSON.stringify(body),
  });
}

export function classifyPicanCreateResponse(status: number, text: string): PicanCreateResult {
  if (status === 409) return { state: "conflict" };
  if (status === 400 || status === 413) return { state: "invalid" };
  const decoded = decodePicanCreateResponseJson(text);
  if (Result.isFailure(decoded)) return { state: "invalid" };
  return classifyDecodedCreateResponse(status, decoded.success);
}

function classifyDecodedCreateResponse(
  status: number,
  response: PicanCreateResponse,
): PicanCreateResult {
  if (response.createState === "unknown" || response.promptDispatchState === "unknown")
    return status === 202 || status === 503
      ? { ...response, state: "unknown" }
      : { state: "invalid" };
  if (response.createState === "creating" || response.promptDispatchState === "dispatching")
    return status === 202 ? { ...response, state: "pending" } : { state: "invalid" };
  if (
    response.createState === "created" &&
    (response.promptDispatchState === "accepted" ||
      response.promptDispatchState === "not_requested")
  )
    return status === 200 ? { ...response, state: "stable" } : { state: "invalid" };
  return { state: "invalid" };
}
