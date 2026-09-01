#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnWrangler, startWrangler } from "../e2e/support/local-worker.mjs";

const [workerConfig, envFile, persistPath, workerName, portText, logFile] = process.argv.slice(2);
const port = Number(portText);
if (
  workerConfig !== "worker/wrangler.jsonc" ||
  envFile === undefined ||
  persistPath === undefined ||
  workerName === undefined ||
  !/^[a-z0-9][a-z0-9-]*$/u.test(workerName) ||
  !Number.isSafeInteger(port) ||
  port <= 0 ||
  logFile === undefined ||
  ![envFile, persistPath, logFile].every(path.isAbsolute)
)
  throw new Error("Scotty lab Wrangler supervisor arguments are invalid");

const envInfo = lstatSync(envFile);
if (!envInfo.isFile() || (envInfo.mode & 0o777) !== 0o600)
  throw new Error("Scotty lab env file must be a private regular file");

const redactedEnvironmentKeys = new Set(["CREDENTIAL_WRAPPING_KEY", "SCOTTY_TOKEN"]);
const secrets = readFileSync(envFile, "utf8")
  .split("\n")
  .flatMap((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) return [];
    if (!redactedEnvironmentKeys.has(line.slice(0, separator))) return [];
    const value = JSON.parse(line.slice(separator + 1));
    return typeof value === "string" && value.length > 0 ? [value] : [];
  });

const started = startWrangler({
  envFile,
  persistPath,
  port,
  name: workerName,
  secrets,
  env: process.env,
  logFile,
  spawnWranglerImpl: (options) => spawnWrangler({ ...options, detached: false }),
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  started.child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const result = await new Promise((resolve) => {
  started.child.once("error", (error) => resolve({ error }));
  started.child.once("close", (code, signal) => resolve({ code, signal }));
});
started.flushLog();
if (started.rawSecretDetected()) process.exitCode = 1;
else if ("error" in result) process.exitCode = 1;
else if (result.signal !== null) process.exitCode = 1;
else process.exitCode = result.code ?? 1;
