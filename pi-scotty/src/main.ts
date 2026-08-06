#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";

import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { defaultConfigPath, defaultStateDirectory, loadConfig, saveConfig } from "./config.ts";
import { FleetConsoleController } from "./controller.ts";
import { PiScottyError, safeErrorMessage } from "./errors.ts";
import { consumePairing } from "./pairing.ts";
import { readSecretLine } from "./secret-input.ts";
import { HttpConsoleTransport } from "./transport.ts";
import { FleetConsoleComponent } from "./ui.ts";

const HELP = `pi-scotty — passive Scotty fleet console

Usage:
  pi-scotty
  pi-scotty pair <origin> [--label <label>] [--config <path>]
  pi-scotty --help

Pairing reads the one-use pairing credential or URL from stdin. It stores only the
standard-client cookie in a mode-0600 pi-scotty config. The console never reads Pi
or Scotty root credentials. Fleet navigation is local; Enter opens a warm session.

Session keys:
  Enter             prompt when idle; steer while streaming
  Option+Enter      queue a follow-up
  Shift+Enter       insert a newline
  Ctrl+C            abort only while the selected turn is active
  Esc               close only the local event stream and return to fleet

Slash commands: /sessions, /subagents, /workflows [runId], /fold (local only)
`;

interface ParsedArguments {
  readonly command: "run" | "pair" | "help";
  readonly origin?: string;
  readonly label: string;
  readonly configPath: string;
}

const parseArguments = (args: ReadonlyArray<string>): ParsedArguments => {
  if (args.includes("--help") || args.includes("-h"))
    return { command: "help", label: "", configPath: defaultConfigPath() };
  const command = args[0] === "pair" ? "pair" : "run";
  const origin = command === "pair" ? args[1] : undefined;
  let label = "pi-scotty";
  let configPath = defaultConfigPath();
  for (let index = command === "pair" ? 2 : 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined)
      throw new PiScottyError("input_invalid", `Missing value for ${flag ?? "option"}`);
    if (flag === "--label") label = value;
    else if (flag === "--config") configPath = value;
    else throw new PiScottyError("input_invalid", `Unknown option: ${flag}`);
  }
  if (command === "pair" && origin === undefined)
    throw new PiScottyError("input_invalid", "pair requires an exact Scotty origin");
  return { command, origin, label, configPath };
};

const pair = async (arguments_: ParsedArguments): Promise<void> => {
  const pairingInput = await readSecretLine("Pairing credential or URL: ");
  const config = await consumePairing({
    origin: arguments_.origin ?? "",
    pairingInput,
    label: arguments_.label,
  });
  await saveConfig(config, arguments_.configPath);
  process.stdout.write(`Paired standard client; config saved to ${arguments_.configPath}\n`);
};

const runConsole = async (configPath: string): Promise<void> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new PiScottyError("input_invalid", "pi-scotty requires an interactive terminal");
  let config = await loadConfig(configPath);
  const stateDirectory = defaultStateDirectory();
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  process.env.PI_TUI_WRITE_LOG = "";
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal, false, stateDirectory);
  const transport = new HttpConsoleTransport(config, {
    onCredential: async (credential) => {
      config = { ...config, credential };
      await saveConfig(config, configPath);
    },
  });
  const controller = new FleetConsoleController(transport, undefined, () => tui.requestRender());
  const exit = (): void => {
    controller.stop();
    tui.stop();
  };
  const component = new FleetConsoleComponent(tui, controller, exit);
  tui.addChild(component);
  tui.setFocus(component);
  tui.start();
  await controller.loadFleet();
};

const main = async (): Promise<void> => {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (arguments_.command === "pair") {
    await pair(arguments_);
    return;
  }
  await runConsole(arguments_.configPath);
};

void main().catch((error: unknown) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
