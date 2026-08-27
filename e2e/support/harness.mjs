import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function resolveCli() {
  const configured = process.env.SCOTTY_E2E_CLI;
  const candidate = configured ? path.resolve(configured) : path.join(ROOT, "cli/scotty.ts");
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `Scotty CLI not found at ${candidate}. Set SCOTTY_E2E_CLI to the source file or compiled executable.`,
    );
  }
  return candidate;
}

export function cliInvocation(args) {
  const cli = resolveCli();
  if (/\.[cm]?tsx?$/.test(cli))
    return { command: process.env.SCOTTY_E2E_BUN ?? "bun", args: [cli, ...args] };
  return { command: cli, args };
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${options.timeoutMs ?? 15_000}ms`));
    }, options.timeoutMs ?? 15_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
  });
}

export async function runCli(args, options = {}) {
  const invocation = cliInvocation(args);
  const result = await runProcess(invocation.command, invocation.args, {
    ...options,
    env: {
      NO_COLOR: "1",
      BROWSER: "true",
      ...options.env,
    },
  });
  return {
    ...result,
    json: parseJson(result.code === 0 ? result.stdout : result.stderr),
    command: [invocation.command, ...invocation.args].join(" "),
  };
}

export function parseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const lines = trimmed.split("\n").reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

export async function git(args, cwd) {
  const result = await runProcess("git", args, { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

export async function poll(fn, predicate, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`poll timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
}
