import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Result } from "effect";
import { EMBEDDED_SKILL } from "../scotty";
import { parseSkillFrontmatterName } from "../src/sandbox-sources";

const skillPath = new URL("../skills/scotty/SKILL.md", import.meta.url);
const readSkill = (): Promise<string> => readFile(skillPath, "utf8");

const commandFamilies = [
  "scotty init",
  "scotty recover",
  "scotty deploy",
  "scotty upgrade",
  "scotty uninstall",
  "scotty doctor",
  "scotty repo add",
  "scotty repo list",
  "scotty repo remove",
  "scotty env list",
  "scotty env set",
  "scotty env remove",
  "scotty env refresh",
  "scotty beam up",
  "scotty beam down",
  "scotty beam vaporize",
  "scotty ls",
  "scotty inspect",
  "scotty steer",
  "scotty attach",
  "scotty snapshot",
  "scotty resume",
  "scotty skills show",
  "scotty sandbox add",
  "scotty sandbox remove",
  "scotty sandbox list",
  "scotty sandbox sync",
  "scotty owner recover",
  "scotty tools list",
  "scotty tools doctor",
  "scotty runner setup",
  "scotty runner serve",
  "scotty runner list",
  "scotty runner remove",
  "scotty tui pair",
  "scotty tui",
] as const;

const setupCriticalCommands = [
  "scotty init",
  "scotty recover",
  "scotty sandbox sync",
  "scotty doctor",
  "scotty owner recover",
  "scotty tui pair",
  "scotty tui",
] as const;

describe("Scotty Skill content contract", () => {
  test("has valid model-invoked frontmatter and setup triggers", async () => {
    const source = await readSkill();
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(source);
    expect(frontmatter).not.toBeNull();
    expect(Result.isSuccess(parseSkillFrontmatterName(source))).toBe(true);
    expect(frontmatter?.[1]).toMatch(/^name:\s*scotty\s*$/mu);

    const description = frontmatter?.[1].match(/^description:\s*(.+)$/mu)?.[1] ?? "";
    for (const trigger of [
      "install",
      "init",
      "configure",
      "finish-setup",
      "recover",
      "operate",
      "inspect",
      "steer",
      "checkpoint",
      "resume",
      "down",
      "vaporize",
      "customize",
      "diagnose",
      "upgrade",
      "remove",
    ])
      expect(description).toContain(trigger);
    expect(frontmatter?.[1]).not.toContain("disable-model-invocation");
  });

  test("teaches every registered public command family", async () => {
    const source = await readSkill();
    for (const command of commandFamilies) expect(source).toContain(command);
  });

  test("names every setup-critical command", async () => {
    const source = await readSkill();
    for (const command of setupCriticalCommands) expect(source).toContain(command);
  });

  test("makes agent-human security checkpoints explicit", async () => {
    const source = await readSkill();
    for (const contract of [
      /choose the name; it is never derived/i,
      /profile name, never a provider credential/i,
      /preview base and zone ID explicitly/i,
      /already-installed user-level runtime/i,
      /do not install software or\s+elevate privileges/i,
      /gh auth login.*locally/i,
      /explicit authorization/i,
      /--yes.*validation/i,
      /revokes every\s+existing browser credential/i,
      /one-use pairing value/i,
      /no-echo prompt/i,
      /never relay its URL or value/i,
      /never for a real credential value/i,
      /--delete-data`?\s+only after explicit approval/i,
    ])
      expect(source).toMatch(contract);
  });

  test("embeds the exact checked-in Markdown source", async () => {
    const source = await readSkill();
    expect(EMBEDDED_SKILL).toBe(source);
  });

  test("contains no stale command or credential-shaped example", async () => {
    const source = await readSkill();
    for (const stale of [
      /\bscotty setup\b/iu,
      /\bscotty skills install\b/iu,
      /\bscotty pr\b/iu,
      /\bscotty publish\b/iu,
      /\bscotty up\b/iu,
      /\bscotty down\b/iu,
      /\bscotty vaporize\b/iu,
    ])
      expect(source).not.toMatch(stale);

    for (const credentialPattern of [
      /\b(?:ghp_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]{8,}/u,
      /\bBearer\s+[A-Za-z0-9._-]{12,}/iu,
      /\bSCOTTY_(?:TOKEN|RUNNER_TOKEN)\s*=/u,
      /scotty_(?:client|pair|recovery|transfer|hatch)\.[A-Za-z0-9._-]+/u,
      /https?:\/\/[^\s)]+[?&](?:token|secret|nonce|code)=/iu,
      /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password)\s*[:=]\s*["']?[A-Za-z0-9]/iu,
      /(?:auth\.json|token-file)/iu,
    ])
      expect(source).not.toMatch(credentialPattern);
  });
});
