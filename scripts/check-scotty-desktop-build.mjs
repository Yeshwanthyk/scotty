import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("desktop Rust build checks skipped: macOS host required");
  process.exit(0);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const commands = [
  ["cargo", ["fmt", "--manifest-path", "desktop/Cargo.toml", "--all", "--", "--check"]],
  [
    "cargo",
    [
      "clippy",
      "--manifest-path",
      "desktop/Cargo.toml",
      "--all-targets",
      "--locked",
      "--",
      "-D",
      "warnings",
    ],
  ],
  ["cargo", ["test", "--manifest-path", "desktop/Cargo.toml", "--locked"]],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
