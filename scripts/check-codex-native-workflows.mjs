import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { CONTAINER_IMAGE, CONTAINER_IMAGE_PLATFORM } from "./check-container-image.mjs";

const root = resolve(import.meta.dirname, "..");
const requiredPasses = 12; // Nine model/effort cases, code-mode command, delegation/follow-up, recovery.
const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--platform",
    CONTAINER_IMAGE_PLATFORM,
    "--network",
    "none",
    "-v",
    `${root}:/repo:ro`,
    "-w",
    "/repo",
    "-e",
    "SCOTTY_REQUIRE_CODEX_NATIVE=1",
    "-e",
    "SCOTTY_TEST_CODEX_BINARY=/usr/local/bin/codex",
    "--entrypoint",
    "node",
    CONTAINER_IMAGE,
    "--test",
    "--test-name-pattern=real pinned binary / synthetic upstream:|packaged gpt-6-astra executes code-mode|packaged Codex delegation preserves parent turn identity|pinned native failed turn saves and resumes with a distinct follow-up",
    "scripts/codex-session-supervisor.test.mjs",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const passed = Number(/^# pass (\d+)$/mu.exec(result.stdout)?.[1]);
if (passed !== requiredPasses)
  throw new Error(`Native Codex workflow gate ran ${passed} of ${requiredPasses} required cases`);
