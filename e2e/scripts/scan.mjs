import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const forbidden = [
  process.env.CODEX_AUTH_JSON,
  process.env.GH_TOKEN,
  process.env.SCOTTY_TOKEN,
  process.env.SCOTTY_E2E_TOKEN,
].filter((value) => value && value.length >= 8);
const excluded = new Set(["node_modules", ".git", "work"]);
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else files.push(target);
  }
}
walk(root);
const leaks = [];
for (const file of files) {
  const body = fs.readFileSync(file);
  for (const secret of forbidden)
    if (body.includes(Buffer.from(secret)))
      leaks.push(`${path.relative(root, file)} contains ${secret.slice(0, 6)}…`);
}
if (leaks.length) {
  process.stderr.write(`Secret scan failed:\n${leaks.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Secret scan passed: ${files.length} repository files checked against ${forbidden.length} configured secrets.\n`,
  );
}
