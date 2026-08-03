import { FleetConsoleController } from "./controller.ts";
import {
  decodeDesktopCommand,
  DESKTOP_PROTOCOL_VERSION,
  projectDesktopState,
  type DesktopCommand,
  type DesktopFrame,
  type DesktopManagementAction,
} from "./desktop-protocol.ts";
import { PiScottyError, safeErrorMessage } from "./errors.ts";
import type { SelectedSession } from "./schemas.ts";
import type { DesktopManagementTransport } from "./transport.ts";

export type DesktopFrameWriter = (frame: DesktopFrame) => void;

type FencedDesktopCommand = Extract<DesktopCommand, { readonly expectedEpoch: string }>;
type ManagementDesktopCommand = Extract<
  DesktopCommand,
  {
    readonly type:
      | "create_sandbox"
      | "rename_sandbox"
      | "snapshot_sandbox"
      | "resume_sandbox"
      | "vaporize_sandbox";
  }
>;

const managementActions = {
  create_sandbox: "create",
  rename_sandbox: "rename",
  snapshot_sandbox: "snapshot",
  resume_sandbox: "resume",
  vaporize_sandbox: "vaporize",
} as const satisfies Record<ManagementDesktopCommand["type"], DesktopManagementAction>;
const managementLabels = {
  create: "Create",
  rename: "Rename",
  snapshot: "Snapshot",
  resume: "Resume",
  vaporize: "Vaporize",
} as const satisfies Record<DesktopManagementAction, string>;

const managementAction = (command: ManagementDesktopCommand): DesktopManagementAction =>
  managementActions[command.type];

export class DesktopSidecar {
  readonly #controller: FleetConsoleController;
  readonly #transport: DesktopManagementTransport;
  readonly #write: DesktopFrameWriter;
  readonly #inFlightRequests = new Set<string>();
  readonly #vaporizedSessionIds = new Set<string>();
  #stopped = false;

  constructor(
    controller: FleetConsoleController,
    transport: DesktopManagementTransport,
    write: DesktopFrameWriter,
  ) {
    this.#controller = controller;
    this.#transport = transport;
    this.#write = write;
  }

  async start(): Promise<void> {
    this.#write({ version: DESKTOP_PROTOCOL_VERSION, type: "ready" });
    await this.#controller.loadFleet();
    this.publish();
  }

  publish(): void {
    if (this.#stopped) return;
    const state = projectDesktopState(this.#controller.state);
    this.#write({
      version: DESKTOP_PROTOCOL_VERSION,
      type: "state",
      state: {
        ...state,
        fleet: state.fleet.filter((session) => !this.#vaporizedSessionIds.has(session.id)),
      },
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
        void this.#controller.inspectSession(command.sessionId).catch((error: unknown) => {
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
      } else if (
        command.type === "create_sandbox" ||
        command.type === "rename_sandbox" ||
        command.type === "snapshot_sandbox" ||
        command.type === "resume_sandbox" ||
        command.type === "vaporize_sandbox"
      ) {
        this.#startManagement(command);
        return true;
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

  #startManagement(command: ManagementDesktopCommand): void {
    const action = managementAction(command);
    const sessionId = command.type === "create_sandbox" ? undefined : command.sessionId;
    if (this.#inFlightRequests.size > 0) {
      this.#write({
        version: DESKTOP_PROTOCOL_VERSION,
        type: "operation",
        requestId: command.requestId,
        action,
        ...(sessionId === undefined ? {} : { sessionId }),
        status: "failed",
        message: "Another sandbox operation is already running",
      });
      return;
    }
    this.#inFlightRequests.add(command.requestId);
    this.#write({
      version: DESKTOP_PROTOCOL_VERSION,
      type: "operation",
      requestId: command.requestId,
      action,
      ...(sessionId === undefined ? {} : { sessionId }),
      status: "started",
      message: `${managementLabels[action]} started`,
    });
    void this.#runManagement(command, action);
  }

  async #runManagement(
    command: ManagementDesktopCommand,
    action: DesktopManagementAction,
  ): Promise<void> {
    let sessionId = command.type === "create_sandbox" ? undefined : command.sessionId;
    let selectedResult: SelectedSession | undefined;
    try {
      if (command.type === "create_sandbox") {
        const created = await this.#transport.createSession(
          {
            title: command.title,
            prompt: command.prompt,
            repo: command.repo,
            hardCapSeconds: command.hardCapSeconds,
          },
          command.requestId,
        );
        sessionId = created.id;
      } else if (command.type === "rename_sandbox") {
        selectedResult = await this.#transport.renameSession(
          command.sessionId,
          command.title,
          command.requestId,
        );
      } else if (command.type === "snapshot_sandbox") {
        selectedResult = await this.#transport.snapshotSession(
          command.sessionId,
          command.requestId,
        );
      } else if (command.type === "resume_sandbox") {
        selectedResult = await this.#transport.resumeSession(command.sessionId, command.requestId);
      } else {
        await this.#transport.vaporizeSession(command.sessionId, command.requestId);
        this.#vaporizedSessionIds.add(command.sessionId);
        if (this.#controller.state.selectedSessionId === command.sessionId)
          this.#controller.closeLocal();
      }
      if (
        selectedResult !== undefined &&
        sessionId !== undefined &&
        this.#controller.state.selectedSessionId === sessionId
      )
        this.#controller.state.setMetadata(sessionId, selectedResult);
      this.#inFlightRequests.delete(command.requestId);
      if (this.#stopped) return;
      await this.#controller.loadFleet();
      if (
        action === "resume" &&
        sessionId !== undefined &&
        this.#controller.state.selectedSessionId === sessionId
      )
        await this.#controller.inspectSession(sessionId);
      this.publish();
      this.#write({
        version: DESKTOP_PROTOCOL_VERSION,
        type: "operation",
        requestId: command.requestId,
        action,
        ...(sessionId === undefined ? {} : { sessionId }),
        status: "succeeded",
        message: `${managementLabels[action]} completed`,
      });
    } catch (error) {
      this.#inFlightRequests.delete(command.requestId);
      if (this.#stopped) return;
      const status =
        error instanceof PiScottyError && error.status !== undefined ? "failed" : "unknown";
      await this.#controller.loadFleet();
      if (this.#stopped) return;
      this.#write({
        version: DESKTOP_PROTOCOL_VERSION,
        type: "operation",
        requestId: command.requestId,
        action,
        ...(sessionId === undefined ? {} : { sessionId }),
        status,
        message:
          status === "failed"
            ? safeErrorMessage(error)
            : `${managementLabels[action]} outcome is unknown; inspect the refreshed fleet before retrying`,
      });
    }
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
  transport: DesktopManagementTransport,
  write: DesktopFrameWriter,
): DesktopSidecar => {
  let publish = (): void => undefined;
  const controller = new FleetConsoleController(transport, undefined, () => publish());
  const sidecar = new DesktopSidecar(controller, transport, write);
  publish = () => sidecar.publish();
  return sidecar;
};
