import { mkdir } from "node:fs/promises";

import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { defaultStateDirectory, normalizeOrigin } from "./config.ts";
import { FleetConsoleController } from "./controller.ts";
import { TuiError } from "./errors.ts";
import { HttpConsoleTransport } from "./transport.ts";
import { FleetConsoleComponent } from "./ui.ts";
import type { TuiConfig } from "./schemas.ts";

export type TuiCredentialPersistence = (credential: string) => Promise<void>;

export const runTuiConsole = async (
  config: TuiConfig,
  persistCredential: TuiCredentialPersistence = async () => undefined,
): Promise<void> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new TuiError("input_invalid", "scotty tui requires an interactive terminal");
  const normalizedConfig: TuiConfig = { ...config, origin: normalizeOrigin(config.origin) };
  const stateDirectory = defaultStateDirectory();
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  process.env.PI_TUI_WRITE_LOG = "";
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal, false, stateDirectory);
  const transport = new HttpConsoleTransport(normalizedConfig, {
    onCredential: persistCredential,
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
