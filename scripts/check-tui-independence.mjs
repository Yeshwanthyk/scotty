import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("tui/package.json", root), "utf8"));
const failures = [];
const PI_CODING_AGENT_VERSION = "0.84.0";

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
  "setThemeInstance",
]);
const FORBIDDEN_OWNERSHIP_APIS =
  /\b(?:InteractiveMode|AgentSession|AgentSessionRuntime|SessionManager|ToolExecutionComponent|createAgentSession|createAgentSessionRuntime|createAgentSessionServices|createCodingTools|create(?:Bash|Edit|Find|Grep|Ls|Read|Write)Tool(?:Definition)?|createLocalBashOperations|RpcClient|runRpcMode)\b/u;

const sourceDirectory = new URL("tui/src/", root);
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
    ["adjacent executable asset access", /process\.execPath/u],
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
const allSources = [...sources.values()].join("\n");
if (!/new TuiMainScreen\(terminal, false, stateDirectory\)/u.test(allSources))
  failures.push("pi-tui must receive Scotty's explicit XDG state/log directory");
if (!/process\.env\.PI_TUI_WRITE_LOG = ""/u.test(allSources))
  failures.push("inherited pi-tui terminal logging must be disabled");
if (!/embeddedThemeSource\s*\(/u.test(sources.get("theme.ts") ?? ""))
  failures.push("theme.ts: presentation themes must come from the embedded source module");
if (!/export\s+(?:const|function)\s+(?:runTuiConsole|pairTuiClient)\b/u.test(mainSource))
  failures.push("main.ts: the embedded CLI must own the exported TUI entry points");

const cliCommandsSource = await readFile(new URL("cli/src/commands.ts", root), "utf8");
if (!/from\s*["']\.\.\/\.\.\/tui\/src\/main\.ts["']/u.test(cliCommandsSource))
  failures.push("cli/src/commands.ts: scotty must import the internal TUI entry points");
if (!/Command\.make\(\s*["']tui["']/u.test(cliCommandsSource))
  failures.push("cli/src/commands.ts: scotty tui must be registered in the CLI command tree");

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
  const work = await mkdtemp(join(tmpdir(), "scotty-tui-package-smoke-"));
  try {
    const binary = join(work, "scotty");
    const build = await run(process.env.BUN_BINARY ?? "bun", ["scripts/build-cli.mjs", binary], {
      cwd: new URL(".", root),
    });
    if (build.code !== 0)
      failures.push(`packaged build failed: ${build.stderr.trim() || build.signal || build.code}`);
    else {
      if (
        await access(join(work, "theme")).then(
          () => true,
          () => false,
        )
      )
        failures.push("standalone scotty must not require an adjacent theme directory");
      const home = join(work, "home");
      const piAuthorityTrap = join(work, "must-not-exist-pi-authority");
      const piLogTrap = join(work, "must-not-exist-pi-log");
      const environment = {
        HOME: home,
        PATH: "",
        XDG_CONFIG_HOME: join(work, "config"),
        XDG_STATE_HOME: join(work, "state"),
        PI_CODING_AGENT_DIR: piAuthorityTrap,
        PI_TUI_WRITE_LOG: piLogTrap,
      };
      for (const [label, args, expected] of [
        ["root", ["--help"], "tui"],
        ["tui", ["tui", "--help"], "interactive Scotty fleet console"],
        ["tui pair", ["tui", "pair", "--help"], "standard Scotty client"],
      ]) {
        const smoke = await run(binary, args, { cwd: work, env: environment });
        if (smoke.code !== 0 || !`${smoke.stdout}\n${smoke.stderr}`.includes(expected))
          failures.push(
            `packaged scotty ${label} smoke failed: ${smoke.stderr.trim() || smoke.signal || smoke.code}`,
          );
      }
      for (const [label, path] of [
        ["Pi authority", piAuthorityTrap],
        ["Pi log", piLogTrap],
        ["root Scotty config", join(home, ".scotty.json")],
        ["legacy pi-scotty config", join(work, "config", "pi-scotty")],
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
  console.log("embedded scotty tui dependency, authority isolation, and standalone smoke passed");
}
