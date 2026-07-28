export interface WarmSession {
  readonly id: string;
  readonly repo: string;
  readonly branch: string;
  readonly updatedAt: string;
}

export interface TranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface SessionSnapshot {
  readonly session: {
    readonly id: string;
    readonly repo: string;
    readonly branch: string;
    readonly url: string;
  };
  readonly running: boolean;
  readonly messages: ReadonlyArray<TranscriptMessage>;
}

class ScottyApiError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseWarmSession(value: unknown): WarmSession {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.repo) ||
    !isString(value.branch) ||
    !isString(value.updatedAt)
  ) {
    throw new ScottyApiError("Scotty returned an invalid warm session");
  }
  return {
    id: value.id,
    repo: value.repo,
    branch: value.branch,
    updatedAt: value.updatedAt,
  };
}

function parseTranscriptMessage(value: unknown): TranscriptMessage {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    (value.role !== "user" && value.role !== "assistant") ||
    !isString(value.text)
  ) {
    throw new ScottyApiError("Scotty returned an invalid transcript message");
  }
  return { id: value.id, role: value.role, text: value.text };
}

function parseSnapshot(value: unknown): SessionSnapshot {
  if (
    !isRecord(value) ||
    !isRecord(value.session) ||
    !isString(value.session.id) ||
    !isString(value.session.repo) ||
    !isString(value.session.branch) ||
    !isString(value.session.url) ||
    typeof value.running !== "boolean" ||
    !Array.isArray(value.messages)
  ) {
    throw new ScottyApiError("Scotty returned an invalid session snapshot");
  }
  return {
    session: {
      id: value.session.id,
      repo: value.session.repo,
      branch: value.session.branch,
      url: value.session.url,
    },
    running: value.running,
    messages: value.messages.map(parseTranscriptMessage),
  };
}

export class ScottyApi {
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#token = token;
  }

  async listSessions(): Promise<ReadonlyArray<WarmSession>> {
    const value = await this.#request("/api/discord/sessions");
    if (!isRecord(value) || !Array.isArray(value.sessions)) {
      throw new ScottyApiError("Scotty returned an invalid sessions response");
    }
    return value.sessions.map(parseWarmSession);
  }

  async getSession(sessionId: string): Promise<SessionSnapshot> {
    const value = await this.#request(`/api/discord/sessions/${encodeURIComponent(sessionId)}`);
    return parseSnapshot(value);
  }

  async isRunning(sessionId: string): Promise<boolean> {
    const value = await this.#request(
      `/api/discord/sessions/${encodeURIComponent(sessionId)}/status`,
    );
    if (!isRecord(value) || typeof value.running !== "boolean") {
      throw new ScottyApiError("Scotty returned an invalid session status");
    }
    return value.running;
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const value = await this.#request(
      `/api/discord/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ message }),
      },
    );
    if (!isRecord(value) || value.accepted !== true) {
      throw new ScottyApiError("Scotty did not accept the message");
    }
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new ScottyApiError(`Scotty request failed with HTTP ${response.status}`);
    }
    const value: unknown = await response.json();
    return value;
  }
}
