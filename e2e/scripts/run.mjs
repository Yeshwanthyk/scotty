import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployed = process.argv.includes("--deployed");
const files = deployed
  ? [path.join(e2eRoot, "tests/deployed.test.mjs")]
  : [
      path.join(e2eRoot, "tests/cli-lifecycle.test.mjs"),
      path.join(e2eRoot, "tests/protocol-security.test.mjs"),
    ];
const env = deployed ? { ...process.env, SCOTTY_E2E_EXPLICIT: "1" } : process.env;
const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
  stdio: "inherit",
  env,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
