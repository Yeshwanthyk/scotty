import { Option, Schema } from "effect";
import {
  Connection,
  ConnectionCreated,
  NewConnection,
  DeliveryOutcome,
  DeliveryReason,
  ConnectionAuthorization,
  ToolPolicy,
} from "../../../src/creds/connections.ts";
import { Size } from "../../../src/places/place.ts";
import { request } from "./core";

const Skill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  manual: Schema.Boolean,
  enabled: Schema.Boolean,
});
const SkillSource = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  path: Schema.String,
  ref: Schema.NullOr(Schema.String),
  commit: Schema.String,
  size: Schema.Number,
  fetched: Schema.Number,
  skills: Schema.Array(Skill),
});
const Settings = Schema.Struct({
  instructions: Schema.String,
  sources: Schema.Array(SkillSource),
  claudeStyle: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  running: Schema.Number,
  maxRunning: Schema.Number,
});
const SourceSaved = Schema.Struct({
  source: Schema.String,
  commit: Schema.String,
  added: Schema.Array(Schema.String),
  updated: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.String),
});
const ChatGpt = Schema.Struct({
  status: Schema.Literals(["signed-in", "expiring", "signed-out"]),
  expiresAt: Schema.NullOr(Schema.Number),
});
const GitHub = Schema.Struct({
  status: Schema.Literals(["set", "missing"]),
  login: Schema.NullOr(Schema.String),
});
const Device = Schema.Struct({
  verificationUrl: Schema.String,
  userCode: Schema.String,
  interval: Schema.Number,
  expiresAt: Schema.Number,
});
const Failed = Schema.Struct({
  status: Schema.Literal("failed"),
  code: Schema.NullOr(Schema.String),
});
const Poll = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("signed-in") }),
  Schema.Struct({ status: Schema.Literal("expired") }),
  Failed,
]);
const GitHubSet = Schema.Union([
  Schema.Struct({ status: Schema.Literal("set"), login: Schema.String }),
  Schema.Struct({ status: Schema.Literal("refused"), httpStatus: Schema.Number }),
]);
const Repos = Schema.Struct({
  repos: Schema.Array(Schema.Struct({ repo: Schema.String, size: Size })),
});

const Connections = Schema.Struct({ connections: Schema.Array(Connection) });
const Deliveries = Schema.Struct({
  deliveries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      connection: Schema.String,
      at: Schema.Number,
      outcome: DeliveryOutcome,
      reason: Schema.NullOr(DeliveryReason),
      session: Schema.NullOr(Schema.String),
    }),
  ),
});

export type Connection = typeof Connection.Type;
export type Delivery = (typeof Deliveries.Type)["deliveries"][number];
export type DeliveryReason = typeof DeliveryReason.Type;
export type Settings = typeof Settings.Type;
export type RepoDefault = (typeof Repos.Type)["repos"][number];
export type Skill = typeof Skill.Type;
export type SkillSource = typeof SkillSource.Type;
export type SourceSaved = typeof SourceSaved.Type;
export type Accounts = {
  chatgpt: typeof ChatGpt.Type;
  claude: typeof ChatGpt.Type;
  github: typeof GitHub.Type;
};
export type Device = typeof Device.Type;

function decode<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
  what: string,
): S["Type"] {
  const result = Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));
  if (result === undefined) throw new Error(`Unreadable ${what}`);
  return result;
}

export async function settings(signal?: AbortSignal): Promise<Settings> {
  return decode(Settings, await request("/api/settings", undefined, signal), "settings");
}

export async function accounts(signal?: AbortSignal): Promise<Accounts> {
  const [chatgpt, claude, github] = await Promise.all([
    request("/api/credentials/chatgpt", undefined, signal),
    request("/api/credentials/claude", undefined, signal),
    request("/api/credentials/github", undefined, signal),
  ]);
  return {
    chatgpt: decode(ChatGpt, chatgpt, "ChatGPT status"),
    claude: decode(ChatGpt, claude, "Claude status"),
    github: decode(GitHub, github, "GitHub status"),
  };
}

export async function saveInstructions(text: string): Promise<void> {
  await request("/api/settings/instructions", { text }, undefined, undefined, "PUT");
}

export async function addSource(source: string): Promise<SourceSaved> {
  return decode(SourceSaved, await request("/api/skill-sources", { source }), "skill source");
}

export async function refreshSource(source: string): Promise<SourceSaved> {
  return decode(
    SourceSaved,
    await request("/api/skill-sources/refresh", { source }),
    "skill source",
  );
}

export async function removeSource(source: string): Promise<void> {
  await request("/api/skill-sources/remove", { source });
}

export async function switchSkill(name: string, enabled: boolean): Promise<void> {
  await request(
    `/api/skills/${encodeURIComponent(name)}`,
    { enabled },
    undefined,
    undefined,
    "PATCH",
  );
}

// Setting a style also switches its skill on.
export async function setClaudeStyle(skill: string | null): Promise<void> {
  await request("/api/settings/claude-style", { skill }, undefined, undefined, "PUT");
}

// Repositories keyed by lowercased owner/repo, each with the size its new sessions start at.
export async function repoDefaults(signal?: AbortSignal): Promise<RepoDefault[]> {
  return [...decode(Repos, await request("/api/repos", undefined, signal), "repositories").repos];
}

// No size clears the default.
export async function setRepoSize(repo: string, size: typeof Size.Type | null): Promise<void> {
  if (size === null) await request(`/api/repos/${repo}`, undefined, undefined, undefined, "DELETE");
  else await request(`/api/repos/${repo}`, { size }, undefined, undefined, "PUT");
}

export async function startChatGpt(): Promise<Device> {
  const value = await request("/api/credentials/chatgpt/start", {});
  const failed = Option.getOrUndefined(Schema.decodeUnknownOption(Failed)(value));
  if (failed !== undefined) throw new Error(`ChatGPT sign-in failed (${failed.code ?? "start"})`);
  return decode(Device, value, "device code");
}

export async function pollChatGpt(): Promise<typeof Poll.Type> {
  return decode(Poll, await request("/api/credentials/chatgpt/poll", {}), "sign-in status");
}

// Only the status comes back; the token is never shown again.
export async function claudeStatus(signal?: AbortSignal): Promise<typeof ChatGpt.Type> {
  return decode(
    ChatGpt,
    await request("/api/credentials/claude", undefined, signal),
    "Claude status",
  );
}

export async function setClaude(token: string): Promise<typeof ChatGpt.Type> {
  return decode(ChatGpt, await request("/api/credentials/claude", { token }), "reply");
}

export async function setGitHub(token: string): Promise<string> {
  const result = decode(GitHubSet, await request("/api/credentials/github", { token }), "reply");
  if (result.status === "refused")
    throw new Error(`GitHub refused the token (HTTP ${result.httpStatus})`);
  return result.login;
}

export async function connections(signal?: AbortSignal): Promise<Connection[]> {
  const value = await request("/api/connections", undefined, signal);
  return [...decode(Connections, value, "connections").connections];
}

// Only a generated webhook secret comes back.
export async function addConnection(
  input: typeof NewConnection.Type,
): Promise<typeof ConnectionCreated.Type> {
  return decode(ConnectionCreated, await request("/api/connections", input), "connection");
}

export async function removeConnection(name: string): Promise<void> {
  await request(
    `/api/connections/${encodeURIComponent(name)}`,
    undefined,
    undefined,
    undefined,
    "DELETE",
  );
}

export async function deliveries(signal?: AbortSignal): Promise<Delivery[]> {
  const value = await request("/api/deliveries", undefined, signal);
  return [...decode(Deliveries, value, "deliveries").deliveries];
}

export async function connectMcp(name: string): Promise<string> {
  const result = decode(
    ConnectionAuthorization,
    await request(`/api/connections/${encodeURIComponent(name)}/connect`, {}),
    "authorization",
  );
  return result.authorizationUrl;
}
export async function setToolPolicy(name: string, policy: typeof ToolPolicy.Type): Promise<void> {
  decode(
    Schema.Struct({ name: Schema.String, policy: ToolPolicy }),
    await request(
      `/api/connections/${encodeURIComponent(name)}/policy`,
      policy,
      undefined,
      undefined,
      "PUT",
    ),
    "policy",
  );
}
