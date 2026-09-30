// The scripts the e2e stand-ins for Codex and Claude read from each prompt, one directive per line:
//   run <command>   runs it with bash in the repository, as the agent's shell tool would
//   sleep <seconds> the same as `run sleep <seconds>`, so an interrupt stops it
//   say <text>      replies with the text; {{out}} is the last command's output, trimmed, and
//                   {{recall}} the session's first prompt, read back from its saved state file
// Any other line is replied as it is. A steer adds its lines to the running turn.
import { spawn, type ChildProcess } from "node:child_process";

export type Step =
  | { readonly kind: "run"; readonly command: string }
  | { readonly kind: "say"; readonly text: string };

export const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");

export const step = (line: string): Step => {
  const trimmed = line.trim();
  const [word = ""] = trimmed.split(/\s+/);
  const argument = trimmed.slice(word.length).trim();
  if (word === "run") return { kind: "run", command: argument };
  if (word === "sleep") return { kind: "run", command: `sleep ${Number(argument) || 0}` };
  return { kind: "say", text: word === "say" ? argument : trimmed };
};

// recall reads the state file, so it runs only when the text asks for it; what it brings back
// is inserted as it is.
export const fill = (text: string, out: string, recall: () => string) => {
  const filled = text.replaceAll("{{out}}", out);
  return filled.includes("{{recall}}") ? filled.replaceAll("{{recall}}", recall()) : filled;
};

// Runs a command with bash; `started` receives the child so an interrupt can kill it.
export const shell = (command: string, cwd: string, started: (child: ChildProcess) => void) =>
  new Promise<{ output: string; exitCode: number }>((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    started(child);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("close", (code) => resolve({ output, exitCode: code ?? 1 }));
  });
