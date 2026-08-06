import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_CODING_AGENT_VERSION,
  PI_THEME_FILES,
  resolvePiCodingAgentPackage,
} from "./pi-scotty-theme-assets.mjs";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("pi-scotty/package.json", root), "utf8"));
const failures = [];

if (packageJson.dependencies?.["@earendil-works/pi-tui"] !== "0.84.0")
  failures.push("@earendil-works/pi-tui must be pinned exactly to 0.84.0");
if (packageJson.dependencies?.["@earendil-works/pi-coding-agent"] !== PI_CODING_AGENT_VERSION)
  failures.push(
    `@earendil-works/pi-coding-agent must be pinned exactly to ${PI_CODING_AGENT_VERSION}`,
  );
for (const dependency of [
  "@earendil-works/pi-client",
  "@earendil-works/pi-protocol",
  "@earendil-works/pi-server",
])
  if (dependency in (packageJson.dependencies ?? {}))
    failures.push(`forbidden dependency: ${dependency}`);

const ALLOWED_CODING_AGENT_IMPORTS = new Set([
  "AssistantMessageComponent",
  "ExtensionSelectorComponent",
  "Theme",
  "ThemeColor",
  "UserMessageComponent",
  "getMarkdownTheme",
  "initTheme",
]);
const FORBIDDEN_OWNERSHIP_APIS =
  /\b(?:InteractiveMode|AgentSession|AgentSessionRuntime|SessionManager|ToolExecutionComponent|createAgentSession|createAgentSessionRuntime|createAgentSessionServices|createCodingTools|create(?:Bash|Edit|Find|Grep|Ls|Read|Write)Tool(?:Definition)?|createLocalBashOperations|RpcClient|runRpcMode)\b/u;

const sourceDirectory = new URL("pi-scotty/src/", root);
const sources = new Map();
for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
  const source = await readFile(join(sourceDirectory.pathname, entry.name), "utf8");
  sources.set(entry.name, source);
  for (const [label, pattern] of [
    ["forbidden Pi package import", /@earendil-works\/pi-(?:client|protocol|server)/u],
    ["coding-agent deep import", /@earendil-works\/pi-coding-agent\//u],
    ["forbidden Pi runtime ownership API", FORBIDDEN_OWNERSHIP_APIS],
    ["legacy RPC fallback", /\/rpc(?:\/|\b)/u],
    ["local Pi process invocation", /(?:spawn|exec|Bun\.spawn)\s*\([^\n]*["'`]pi["'`]/u],
    ["PI_CODING_AGENT_DIR access", /PI_CODING_AGENT_DIR/u],
    ["root Scotty config access", /\.scotty\.json/u],
    ["process execution import", /node:child_process/u],
  ])
    if (pattern.test(source)) failures.push(`${entry.name}: ${label}`);

  for (const match of source.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["']@earendil-works\/pi-coding-agent["']/gu,
  )) {
    for (const imported of (match[1] ?? "").split(",")) {
      const name = imported
        .trim()
        .replace(/^type\s+/u, "")
        .split(/\s+as\s+/u)[0];
      if (name && !ALLOWED_CODING_AGENT_IMPORTS.has(name))
        failures.push(`${entry.name}: forbidden coding-agent export import: ${name}`);
    }
  }
  if (
    /from\s*["']@earendil-works\/pi-coding-agent["']/u.test(source) &&
    !/import\s*\{/u.test(source)
  )
    failures.push(`${entry.name}: coding-agent imports must be explicit named UI exports`);
}

const mainSource = sources.get("main.ts") ?? "";
if (!/new TuiMainScreen\(terminal, false, stateDirectory\)/u.test(mainSource))
  failures.push("main.ts: pi-tui must receive Scotty's explicit XDG state/log directory");
if (!/process\.env\.PI_TUI_WRITE_LOG = ""/u.test(mainSource))
  failures.push("main.ts: inherited pi-tui terminal logging must be disabled");

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

if (failures.length === 0) {
  const work = await mkdtemp(join(tmpdir(), "pi-scotty-package-smoke-"));
  try {
    const binary = join(work, "pi-scotty");
    const build = await run(process.execPath, ["scripts/build-pi-scotty.mjs", binary], {
      cwd: new URL(".", root),
    });
    if (build.code !== 0)
      failures.push(`packaged build failed: ${build.stderr.trim() || build.signal || build.code}`);
    else {
      const { themeDirectory } = await resolvePiCodingAgentPackage();
      for (const file of PI_THEME_FILES) {
        const [source, packaged] = await Promise.all([
          readFile(join(themeDirectory, file), "utf8"),
          readFile(join(work, "theme", file), "utf8").catch(() => undefined),
        ]);
        if (packaged !== source) failures.push(`packaged theme asset is missing or stale: ${file}`);
      }
      const home = join(work, "home");
      const piAuthorityTrap = join(work, "must-not-exist-pi-authority");
      const piLogTrap = join(work, "must-not-exist-pi-log");
      const smoke = await run(binary, ["--help"], {
        cwd: work,
        env: {
          HOME: home,
          PATH: "",
          XDG_CONFIG_HOME: join(work, "config"),
          XDG_STATE_HOME: join(work, "state"),
          PI_CODING_AGENT_DIR: piAuthorityTrap,
          PI_TUI_WRITE_LOG: piLogTrap,
        },
      });
      if (smoke.code !== 0 || !smoke.stdout.includes("passive Scotty fleet console"))
        failures.push(
          `packaged no-Pi smoke failed: ${smoke.stderr.trim() || smoke.signal || smoke.code}`,
        );
      for (const [label, path] of [
        ["Pi authority", piAuthorityTrap],
        ["Pi log", piLogTrap],
      ])
        if (
          await access(path).then(
            () => true,
            () => false,
          )
        )
          failures.push(`packaged smoke wrote the ${label} trap: ${path}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("pi-scotty UI-only Pi dependency, packaged themes, and no-Pi smoke passed");
}
