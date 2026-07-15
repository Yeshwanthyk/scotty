export type LifecycleAction = "up" | "down" | "vaporize" | "resume" | "list" | "status" | "help";

export type OutputMode = "text" | "json";

export type UpInput = {
  cwd?: string;
  force: boolean;
  project?: string;
  provider?: string;
  prompt?: string;
  title?: string;
  branch?: string;
  session?: string;
};

export type DownInput = {
  id: string;
  cwd?: string;
  force: boolean;
};

export type SessionIdentity = {
  id: string;
  url: string;
};

export type UpResult = SessionIdentity & {
  status: "active" | "saved" | "waking";
  ssh?: string;
};

export type DownResult = {
  id: string;
  status: "down";
  resume: string[];
};

export type VaporizeResult = SessionIdentity & {
  status: "vaporized";
};

export type ResumeResult = SessionIdentity & {
  status: "running" | "waking";
};

export type SessionSummary = SessionIdentity & {
  ssh?: string;
  status: string;
  provider: string;
  project: string;
  title: string | null;
  updatedAt: number;
  queuedPrompts: number;
  deleted: boolean;
};

export type ListResult = {
  sessions: SessionSummary[];
};

export type StatusResult = SessionSummary & {
  heartbeatAt: number | null;
  flushAt: number | null;
  error: string | null;
};

export interface LifecycleBackend {
  up(input: UpInput): Promise<UpResult>;
  down(input: DownInput): Promise<DownResult>;
  vaporize(id: string): Promise<VaporizeResult>;
  resume(id: string): Promise<ResumeResult>;
  list(all: boolean): Promise<ListResult>;
  status(id: string): Promise<StatusResult>;
}

export type CliIo = {
  stdout(text: string): void;
  stderr(text: string): void;
};
