import { Option, Schema } from "effect";
import { request } from "./core";

const Skill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  size: Schema.Number,
  updated: Schema.Number,
});
const Settings = Schema.Struct({
  instructions: Schema.String,
  skills: Schema.Array(Skill),
  email: Schema.NullOr(Schema.String),
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

const Connection = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  created: Schema.Number,
  url: Schema.String,
});
const Connections = Schema.Struct({ connections: Schema.Array(Connection) });
const ConnectionCreated = Schema.Struct({ ...Connection.fields, secret: Schema.String });
const Deliveries = Schema.Struct({
  deliveries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      connection: Schema.String,
      at: Schema.Number,
      outcome: Schema.Literals(["accepted", "rejected", "duplicate"]),
      reason: Schema.NullOr(Schema.String),
      session: Schema.NullOr(Schema.String),
    }),
  ),
});

export type Connection = typeof Connection.Type;
export type Delivery = (typeof Deliveries.Type)["deliveries"][number];
export type Settings = typeof Settings.Type;
export type Skill = typeof Skill.Type;
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

export async function uploadSkill(zip: Blob): Promise<void> {
  await request("/api/skills", zip, undefined, undefined, "PUT");
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

export async function removeSkill(name: string): Promise<void> {
  await request(
    `/api/skills/${encodeURIComponent(name)}`,
    undefined,
    undefined,
    undefined,
    "DELETE",
  );
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

// The secret comes back once, in this reply only.
export async function addWebhook(name: string): Promise<typeof ConnectionCreated.Type> {
  return decode(
    ConnectionCreated,
    await request("/api/connections", { kind: "webhook", name }),
    "connection",
  );
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
