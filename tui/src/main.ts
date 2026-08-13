import { mkdir } from "node:fs/promises";

import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { defaultConfigPath, defaultStateDirectory, loadConfig, saveConfig } from "./config.ts";
import { FleetConsoleController } from "./controller.ts";
import { TuiError } from "./errors.ts";
import { consumePairing } from "./pairing.ts";
import { readSecretLine } from "./secret-input.ts";
import { HttpConsoleTransport } from "./transport.ts";
import { FleetConsoleComponent } from "./ui.ts";

export interface PairTuiClientOptions {
  readonly origin: string;
  readonly label: string;
  readonly configPath?: string;
}

export const pairTuiClient = async (options: PairTuiClientOptions): Promise<void> => {
  const pairingInput = await readSecretLine("Pairing credential or URL: ");
  const config = await consumePairing({
    origin: options.origin,
    pairingInput,
    label: options.label,
  });
  const configPath = options.configPath ?? defaultConfigPath();
  await saveConfig(config, configPath);
  process.stdout.write(`Paired standard client; config saved to ${configPath}\n`);
};

export const runTuiConsole = async (configPath = defaultConfigPath()): Promise<void> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new TuiError("input_invalid", "scotty tui requires an interactive terminal");
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
