import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import scottyPlugin from "./oxlint-plugin-scotty.js";

const rulesRoot = path.resolve("scripts/oxlint-plugin-scotty/rules");
const skillsRoot = path.resolve(".agents/skills");
const config = await readFile(path.resolve(".oxlintrc.json"), "utf8");
const enabledRules = new Set();
const requiredSkills = new Set([
  "decoding-effect-boundaries",
  "deriving-schema-types",
  "maintaining-typescript-safety",
  "modeling-effect-errors",
  "routing-effect-http",
  "testing-effect-programs",
  "wrapping-promise-clients",
]);

for (const match of config.matchAll(
  /"scotty\/([a-z0-9-]+)"\s*:\s*(?:"(?:error|warn)"|[12]|\[\s*(?:"(?:error|warn)"|[12]))/gu,
)) {
  enabledRules.add(match[1]);
}

const availableRules = new Set(
  (await readdir(rulesRoot))
    .filter((name) => name.endsWith(".js"))
    .map((name) => name.slice(0, -3)),
);
const missingRules = [...enabledRules].filter((rule) => !availableRules.has(rule)).sort();
const exportedRules = new Set(Object.keys(scottyPlugin.rules));
const missingPluginRules = [...availableRules].filter((rule) => !exportedRules.has(rule)).sort();
const references = new Set();

for (const rule of [...enabledRules].sort()) {
  if (!availableRules.has(rule)) continue;
  const source = await readFile(path.join(rulesRoot, `${rule}.js`), "utf8");
  for (const match of source.matchAll(
    /\b(?:modeling|decoding|deriving|wrapping|testing|maintaining|routing)-[a-z0-9-]+\b/gu,
  )) {
    references.add(match[0]);
  }
}

const missingSkills = [];
for (const skill of new Set([...references, ...requiredSkills])) {
  try {
    await access(path.join(skillsRoot, skill, "SKILL.md"));
  } catch {
    missingSkills.push(skill);
  }
}

if (missingRules.length > 0 || missingPluginRules.length > 0 || missingSkills.length > 0) {
  const problems = [];
  if (missingRules.length > 0)
    problems.push(`Missing enabled lint rule sources: ${missingRules.join(", ")}`);
  if (missingPluginRules.length > 0)
    problems.push(`Rule sources missing from plugin exports: ${missingPluginRules.join(", ")}`);
  if (missingSkills.length > 0)
    problems.push(`Missing lint remediation skills: ${missingSkills.join(", ")}`);
  throw new Error(problems.join("\n"));
}

console.log(
  `Verified ${enabledRules.size} enabled Scotty lint rule sources, ${references.size} diagnostic skill references, and ${requiredSkills.size} required skills.`,
);
