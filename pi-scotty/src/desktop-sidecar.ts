import { FleetConsoleController } from "./controller.ts";
import {
  decodeDesktopCommand,
  DESKTOP_PROTOCOL_VERSION,
  projectDesktopState,
  type DesktopCommand,
  type DesktopFrame,
} from "./desktop-protocol.ts";
import { PiScottyError, safeErrorMessage } from "./errors.ts";
import type { ConsoleTransport } from "./transport.ts";

export type DesktopFrameWriter = (frame: DesktopFrame) => void;

type FencedDesktopCommand = Extract<DesktopCommand, { readonly expectedEpoch: string }>;

export class DesktopSidecar {
  readonly #controller: FleetConsoleController;
  readonly #write: DesktopFrameWriter;
  #stopped = false;

  constructor(controller: FleetConsoleController, write: DesktopFrameWriter) {
    this.#controller = controller;
    this.#write = write;
  }

  async start(): Promise<void> {
    this.#write({ version: DESKTOP_PROTOCOL_VERSION, type: "ready" });
    await this.#controller.loadFleet();
    this.publish();
  }

  publish(): void {
    if (this.#stopped) return;
    this.#write({
      version: DESKTOP_PROTOCOL_VERSION,
      type: "state",
      state: projectDesktopState(this.#controller.state),
    });
  }

  async handleLine(line: string): Promise<boolean> {
    const command = decodeDesktopCommand(line);
    if (command === undefined) {
      this.#write({
        version: DESKTOP_PROTOCOL_VERSION,
        type: "error",
        code: "invalid_command",
        message: "Desktop command was invalid",
      });
      return true;
    }

    try {
      if (command.type === "refresh_fleet") await this.#controller.loadFleet();
      else if (command.type === "select") {
        void this.#controller.openSession(command.sessionId).catch((error: unknown) => {
          if (this.#stopped) return;
          this.#write({
            version: DESKTOP_PROTOCOL_VERSION,
            type: "error",
            code: "command_failed",
            message: safeErrorMessage(error),
          });
        });
      } else if (command.type === "close") this.#controller.closeLocal();
      else if (command.type === "set_draft") {
        this.#setDraft(command.sessionId, command.text);
        return true;
      } else if (command.type === "submit") {
        this.#assertFence(command);
        this.#setDraft(command.sessionId, command.text);
        await this.#controller.submitDraft(command.forceFollowUp ?? false);
      } else if (command.type === "abort") {
        this.#assertFence(command);
        await this.#controller.abortActive();
      } else if (command.type === "answer") {
        this.#assertFence(command);
        await this.#controller.answerExtensionUi(
          command.requestId,
          command.answer.type === "value"
            ? { value: command.answer.value }
            : command.answer.type === "confirmed"
              ? { confirmed: command.answer.confirmed }
              : { cancelled: true },
        );
      } else if (command.type === "shutdown") {
        this.stop();
        return false;
      }
    } catch (error) {
      this.#write({
        version: DESKTOP_PROTOCOL_VERSION,
        type: "error",
        code: "command_failed",
        message: safeErrorMessage(error),
      });
      return true;
    }
    this.publish();
    return true;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#controller.stop();
    this.#stopped = true;
    this.#write({ version: DESKTOP_PROTOCOL_VERSION, type: "stopped" });
  }

  #assertSelected(sessionId: string): void {
    if (this.#controller.state.selectedSessionId !== sessionId)
      throw new PiScottyError("input_invalid", "Desktop selection changed; retry the command");
  }

  #assertFence(command: FencedDesktopCommand): void {
    this.#assertSelected(command.sessionId);
    const live = this.#controller.state.cache(command.sessionId).live;
    if (
      live === undefined ||
      live.epoch !== command.expectedEpoch ||
      live.sessionRevision !== command.expectedSessionRevision
    )
      throw new PiScottyError("input_invalid", "Desktop session changed; retry the command");
  }

  #setDraft(sessionId: string, text: string): void {
    this.#assertSelected(sessionId);
    this.#controller.state.setDraft(sessionId, text);
  }
}

export const makeDesktopSidecar = (
  transport: ConsoleTransport,
  write: DesktopFrameWriter,
): DesktopSidecar => {
  let publish = (): void => undefined;
  const controller = new FleetConsoleController(transport, undefined, () => publish());
  const sidecar = new DesktopSidecar(controller, write);
  publish = () => sidecar.publish();
  return sidecar;
};
