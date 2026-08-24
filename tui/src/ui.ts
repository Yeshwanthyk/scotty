import {
  AssistantMessageComponent,
  ExtensionSelectorComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Key,
  Markdown,
  matchesKey,
  Text,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { Schema } from "effect";
import type { FleetConsoleController } from "./controller.ts";
import { adaptRemoteMessage, adaptRemoteTool, type RemoteToolCall } from "./remote-ui-adapters.ts";
import { formatRemoteValue, redactRemoteLine, redactRemoteString } from "./redaction.ts";
import type { FleetSession } from "./schemas.ts";
import { SETTLED_TURNS_FOLD_ID, type ToolProjection } from "./state.ts";
import { initializePiPresentation } from "./theme.ts";

const color = {
  accent: (value: string) => initializePiPresentation().theme.fg("accent", value),
  muted: (value: string) => initializePiPresentation().theme.fg("muted", value),
  success: (value: string) => initializePiPresentation().theme.fg("success", value),
  warning: (value: string) => initializePiPresentation().theme.fg("warning", value),
  error: (value: string) => initializePiPresentation().theme.fg("error", value),
};

const lifecycle = (session: FleetSession): string => {
  const value = redactRemoteLine(session.status);
  if (session.status === "warm") return color.success(value);
  if (session.operationResult?.outcome.status === "failed") return color.error(value);
  return color.warning(value);
};

const sessionLine = (session: FleetSession, cursor: boolean): string => {
  const marker = cursor ? color.accent("›") : " ";
  const activity = session.agentState ?? "unknown";
  const eligibility =
    session.status === "warm" && session.provider === "cloudflare" ? "" : " · unavailable";
  return `${marker} ${lifecycle(session)} ${redactRemoteLine(session.title)}  ${color.muted(
    `${redactRemoteLine(session.repo)} · ${redactRemoteLine(activity)} @ ${redactRemoteLine(session.projectedAt)}${eligibility}`,
  )}`;
};

export const composerKeyRoute = (data: string): "submit" | "follow_up" | "newline" | "editor" => {
  if (matchesKey(data, Key.alt(Key.enter))) return "follow_up";
  if (matchesKey(data, Key.shift(Key.enter))) return "newline";
  if (matchesKey(data, Key.enter)) return "submit";
  return "editor";
};

export const safeTerminalTitle = (title: string | undefined): string => {
  const remote = redactRemoteString(title ?? "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return remote ? `scotty tui — ${remote}` : "scotty tui";
};

const isBlockingMethod = (method: string): method is "select" | "confirm" | "input" | "editor" =>
  method === "select" || method === "confirm" || method === "input" || method === "editor";

const normalizeRenderedLine = (value: string): string => value.replaceAll(/[\t\r\n]+/gu, " ");

const renderChild = (component: Component, width: number): string[] =>
  component.render(width).map(normalizeRenderedLine);

const renderFleetSelector = (component: ExtensionSelectorComponent, width: number): string[] =>
  component.render(width).map((line) => {
    const normalized = normalizeRenderedLine(line);
    return redactRemoteString(normalized).includes("escape/ctrl+c cancel")
      ? color.muted("Ctrl+G cancel · Esc fleet · Ctrl+C abort active")
      : normalized;
  });

const renderSessionsSelector = (component: ExtensionSelectorComponent, width: number): string[] =>
  component.render(width).map((line) => {
    const normalized = normalizeRenderedLine(line);
    return redactRemoteString(normalized).includes("escape/ctrl+c cancel")
      ? color.muted("↑/↓ or j/k move · Enter switch · Esc/Ctrl+C close")
      : normalized;
  });

class RemoteToolCard implements Component {
  readonly #tool: RemoteToolCall;
  #result:
    | { readonly text: string; readonly isError: boolean; readonly partial: boolean }
    | undefined;

  constructor(tool: RemoteToolCall) {
    this.#tool = tool;
  }

  updateArguments(arguments_: RemoteToolCall["arguments"]): void {
    Object.assign(this.#tool.arguments, arguments_);
  }

  updateResult(text: string, isError: boolean, partial: boolean): void {
    this.#result = { text, isError, partial };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { markdown, theme } = initializePiPresentation();
    const result = this.#result;
    const state =
      result === undefined
        ? theme.fg("warning", "running")
        : result.partial
          ? theme.fg("warning", "streaming")
          : result.isError
            ? theme.fg("error", "failed")
            : theme.fg("success", "done");
    const lines = [
      ...new Text(
        `${theme.fg("toolTitle", redactRemoteLine(this.#tool.presentationName))} · ${state}`,
        1,
        0,
      ).render(width),
      ...new Markdown(formatRemoteValue(this.#tool.arguments), 2, 0, markdown, {
        color: (text) => theme.fg("toolOutput", text),
      }).render(width),
    ];
    if (result !== undefined)
      lines.push(
        ...new Markdown(result.text, 2, 0, markdown, {
          color: (text) => theme.fg(result.isError ? "error" : "toolOutput", text),
        }).render(width),
      );
    return lines;
  }
}

export class FleetConsoleComponent implements Component {
  readonly #controller: FleetConsoleController;
  readonly #onExit: () => void;
  readonly #tui: TUI;
  readonly #editor: Editor;
  readonly #selectors = new Map<string, ExtensionSelectorComponent>();
  #sessionsSelector:
    | { readonly generation: number; readonly component: ExtensionSelectorComponent }
    | undefined;
  #editorTarget = "";
  #syncingEditor = false;
  #terminalTitle = "";

  constructor(tui: TUI, controller: FleetConsoleController, onExit: () => void) {
    initializePiPresentation();
    this.#controller = controller;
    this.#onExit = onExit;
    this.#tui = tui;
    this.#editor = new Editor(tui, {
      borderColor: color.accent,
      selectList: {
        selectedPrefix: color.accent,
        selectedText: color.accent,
        description: color.muted,
        scrollInfo: color.muted,
        noMatch: color.muted,
      },
    });
    this.#editor.onChange = (text) => {
      if (this.#syncingEditor) return;
      const selected = this.#controller.state.selectedSessionId;
      if (selected === undefined) return;
      const cache = this.#controller.state.cache(selected);
      const dialog = cache.live?.pendingUi.find((request) => isBlockingMethod(request.method));
      if (dialog?.method === "input" || dialog?.method === "editor")
        cache.dialogDrafts.set(dialog.id, text);
      else this.#controller.state.setDraft(selected, text);
    };
    this.#editor.onSubmit = (text) => void this.#submitEditor(text);
  }

  invalidate(): void {
    this.#editor.invalidate();
    this.#sessionsSelector?.component.invalidate();
    for (const selector of this.#selectors.values()) selector.invalidate();
  }

  handleInput(data: string): void {
    const state = this.#controller.state;
    if (state.selectedSessionId === undefined) {
      if (matchesKey(data, "q")) {
        this.#onExit();
        return;
      }
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.#controller.moveFleetCursor(-1);
        return;
      }
      if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        this.#controller.moveFleetCursor(1);
        return;
      }
      if (matchesKey(data, Key.enter)) void this.#controller.openCursor();
      return;
    }

    const picker = state.sessionsPicker;
    if (picker.status !== "closed") {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))
        this.#controller.closeSessionsPicker();
      else if (picker.status === "open") this.#sessionPickerSelector().handleInput(data);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.#controller.closeLocal();
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      void this.#controller.abortActive();
      return;
    }

    const selected = state.selectedSessionId;
    const cache = state.cache(selected);
    const live = cache.live;
    const dialog = live?.pendingUi.find((request) => isBlockingMethod(request.method));
    if (dialog !== undefined && cache.uiAnswers.has(`${live?.epoch ?? "unknown"}\0${dialog.id}`))
      return;
    if (dialog !== undefined && matchesKey(data, Key.ctrl("g"))) {
      void this.#controller.answerExtensionUi(dialog.id, { cancelled: true });
      return;
    }
    if (dialog?.method === "select" || dialog?.method === "confirm") {
      if (dialog.method === "select") {
        if (matchesKey(data, Key.up) || matchesKey(data, "k"))
          cache.dialogCursor = Math.max(0, cache.dialogCursor - 1);
        else if (matchesKey(data, Key.down) || matchesKey(data, "j"))
          cache.dialogCursor = Math.min(dialog.options.length - 1, cache.dialogCursor + 1);
      } else if (matchesKey(data, "y")) {
        void this.#controller.answerExtensionUi(dialog.id, { confirmed: true });
        return;
      } else if (matchesKey(data, "n")) {
        void this.#controller.answerExtensionUi(dialog.id, { confirmed: false });
        return;
      }
      this.#selector(selected, live?.epoch ?? "unknown", dialog).handleInput(data);
      return;
    }

    this.#syncEditor();
    if (dialog === undefined && composerKeyRoute(data) === "follow_up") {
      void this.#controller.submitDraft(true);
      return;
    }
    this.#editor.handleInput(data);
  }

  render(width: number): string[] {
    this.#syncEditor();
    const state = this.#controller.state;
    const selectedTitle =
      state.selectedSessionId === undefined
        ? undefined
        : state.cache(state.selectedSessionId).live?.extensionSurface.title;
    this.#updateTerminalTitle(selectedTitle);
    const lines = [
      `${color.accent("scotty tui")} ${color.muted("Scotty fleet console")}`,
      color.muted(
        state.selectedSessionId === undefined
          ? "↑/↓ or j/k move · Enter open warm session · q quit"
          : state.sessionsPicker.status === "closed"
            ? "Enter prompt/steer · Option+Enter follow-up · Shift+Enter newline · Ctrl+C abort active · Esc fleet"
            : "Session picker active · Esc closes picker · next Esc returns to fleet",
      ),
      "",
    ];

    if (state.selectedSessionId === undefined) {
      lines.push(color.accent("FLEET"));
      if (state.fleetError !== undefined) lines.push(color.error(state.fleetError));
      if (state.fleet.length === 0 && state.fleetError === undefined)
        lines.push(color.muted("No sessions"));
      const fleetStart = Math.max(0, state.fleetCursor - 3);
      for (const [offset, session] of state.fleet.slice(fleetStart, fleetStart + 8).entries())
        lines.push(sessionLine(session, fleetStart + offset === state.fleetCursor));
      return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
    }

    const selectedId = state.selectedSessionId;
    const cache = state.cache(selectedId);
    const metadata = cache.metadata ?? state.fleet.find((session) => session.id === selectedId);
    lines.push(
      color.accent(
        redactRemoteLine(cache.live?.extensionSurface.title ?? metadata?.title ?? "SESSION"),
      ),
    );
    if (metadata !== undefined)
      lines.push(
        `${redactRemoteLine(metadata.repo)}#${redactRemoteLine(metadata.branch)} · ${lifecycle(metadata)} · ${redactRemoteLine(cache.live?.activity ?? metadata.agentState ?? "unknown")} · revision ${cache.live?.sessionRevision ?? "unavailable"}`,
      );
    if (state.loading) lines.push(color.muted("Loading passive snapshot…"));
    if (cache.unavailable !== undefined)
      lines.push(
        color.warning(`Passive console unavailable: ${redactRemoteLine(cache.unavailable.reason)}`),
      );
    if (cache.error !== undefined) lines.push(color.error(cache.error));

    const live = cache.live;
    if (live !== undefined) {
      const statuses = Object.entries(live.extensionSurface.statuses);
      if (statuses.length > 0)
        lines.push(
          color.muted(
            statuses
              .map(([key, value]) => `${redactRemoteLine(key)}: ${redactRemoteLine(value)}`)
              .join(" · "),
          ),
        );
      for (const notification of live.notifications.slice(-3)) {
        const style =
          notification.type === "error"
            ? color.error
            : notification.type === "warning"
              ? color.warning
              : color.accent;
        lines.push(
          style(
            `${redactRemoteLine(notification.type)}: ${redactRemoteLine(notification.message)}`,
          ),
        );
      }

      lines.push("", color.accent(`TRANSCRIPT (${live.messages.length})`));
      let visibleMessages: ReadonlyArray<Schema.Json> = live.messages;
      if (cache.folded.has(SETTLED_TURNS_FOLD_ID) && live.messages.length > 0) {
        const foldedCount = Math.max(0, live.messages.length - 1);
        if (foldedCount > 0)
          lines.push(color.muted(`  ▸ ${foldedCount} older settled transcript entries folded`));
        visibleMessages = live.messages.slice(-1);
      } else {
        const end = Math.max(0, live.messages.length - cache.scroll);
        const start = Math.max(0, end - 10);
        visibleMessages = live.messages.slice(start, end);
      }
      lines.push(...this.#renderTranscript(visibleMessages, [...live.activeTools.values()], width));
      if (live.messages.length === 0 && live.activeTools.size === 0)
        lines.push(color.muted("  No transcript messages"));

      const aboveEditorWidgets = live.extensionSurface.widgets.filter(
        (widget) => widget.placement !== "belowEditor",
      );
      const belowEditorWidgets = live.extensionSurface.widgets.filter(
        (widget) => widget.placement === "belowEditor",
      );
      for (const widget of aboveEditorWidgets)
        lines.push(...widget.lines.map((line) => color.muted(`  ${redactRemoteLine(line)}`)));

      const dialog = live.pendingUi.find((request) => isBlockingMethod(request.method));
      const picker = state.sessionsPicker;
      if (picker.status !== "closed") {
        lines.push("");
        if (picker.status === "loading")
          lines.push(color.accent("SESSIONS"), color.muted("Refreshing fleet…"));
        else if (picker.status === "error")
          lines.push(
            color.accent("SESSIONS"),
            color.error(picker.message ?? "Fleet refresh failed"),
            color.muted("Esc close"),
          );
        else {
          lines.push(...renderSessionsSelector(this.#sessionPickerSelector(), width));
          if (picker.message !== undefined) lines.push(color.warning(picker.message));
        }
      } else if (dialog !== undefined) {
        lines.push("");
        const answerStatus = cache.uiAnswers.get(`${live.epoch}\0${dialog.id}`);
        if (answerStatus === "in_flight") lines.push(color.muted("Answer in flight…"));
        else if (answerStatus === "delivered_unconfirmed")
          lines.push(
            color.warning("Awaiting Pi continuation; response outcome remains unconfirmed"),
          );
        else if (answerStatus === "outcome_unknown")
          lines.push(
            color.warning("Answer outcome unknown; fresh pending state is required to retry"),
          );
        if (dialog.method === "select" || dialog.method === "confirm")
          lines.push(...renderFleetSelector(this.#selector(selectedId, live.epoch, dialog), width));
        else {
          lines.push(color.warning(`REQUEST · ${redactRemoteLine(dialog.title)}`));
          if (dialog.method === "input" && dialog.placeholder)
            lines.push(color.muted(redactRemoteLine(dialog.placeholder)));
          lines.push(color.muted("Enter submit · Shift+Enter newline · Ctrl+G cancel · Esc fleet"));
          lines.push(...this.#editor.render(width));
        }
      } else {
        lines.push("", color.accent(live.isStreaming ? "STEER" : "PROMPT"));
        lines.push(...this.#editor.render(width));
      }
      for (const widget of belowEditorWidgets)
        lines.push(...widget.lines.map((line) => color.muted(`  ${redactRemoteLine(line)}`)));
      if (cache.commandStatus !== undefined)
        lines.push(color.muted(redactRemoteLine(cache.commandStatus)));
      lines.push(
        color.muted(
          "Commands: /sessions · /subagents · /workflows [runId] · /fold (local settled-turn folding)",
        ),
      );
    }
    return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  #renderTranscript(
    messages: ReadonlyArray<Schema.Json>,
    activeTools: ReadonlyArray<ToolProjection>,
    width: number,
  ): string[] {
    const components: Component[] = [];
    const tools = new Map<string, RemoteToolCard>();
    const markdown = initializePiPresentation().markdown;
    for (const remote of messages) {
      const entry = adaptRemoteMessage(remote);
      if (entry.kind === "user") {
        components.push(new UserMessageComponent(entry.text, markdown, 1));
      } else if (entry.kind === "assistant") {
        components.push(
          new AssistantMessageComponent(entry.message, false, markdown, "Thinking…", 1),
        );
        for (const tool of entry.tools) {
          const component = new RemoteToolCard(tool);
          tools.set(tool.id, component);
          components.push(component);
        }
      } else if (entry.kind === "tool_result") {
        let component = tools.get(entry.result.toolCallId);
        if (component === undefined) {
          component = new RemoteToolCard({
            id: entry.result.toolCallId,
            name: entry.result.toolName,
            presentationName: `${entry.result.toolName} (remote)`,
            arguments: {},
          });
          tools.set(entry.result.toolCallId, component);
          components.push(component);
        }
        component.updateResult(entry.result.text, entry.result.isError, false);
      } else {
        components.push(new Text(color.muted(entry.text), 1, 0));
      }
    }

    for (const remote of activeTools) {
      const tool = adaptRemoteTool(remote);
      let component = tools.get(tool.id);
      if (component === undefined) {
        component = new RemoteToolCard(tool);
        tools.set(tool.id, component);
        components.push(component);
      } else component.updateArguments(tool.arguments);
      if (tool.partialText !== undefined) component.updateResult(tool.partialText, false, true);
    }
    return components.flatMap((component) => renderChild(component, width));
  }

  #sessionPickerSelector(): ExtensionSelectorComponent {
    const picker = this.#controller.state.sessionsPicker;
    const existing = this.#sessionsSelector;
    if (existing?.generation === picker.generation) return existing.component;
    const selectedId = this.#controller.state.selectedSessionId;
    const sessions = [
      ...this.#controller.state.fleet.filter((session) => session.id === selectedId),
      ...this.#controller.state.fleet.filter((session) => session.id !== selectedId),
    ];
    const options = sessions.map((session, index) => {
      const current = session.id === selectedId ? " · current" : "";
      return `${index + 1}. ${sessionLine(session, false).trim()}${current}`;
    });
    const component = new ExtensionSelectorComponent(
      "Sessions",
      options,
      (option) => {
        const session = sessions[options.indexOf(option)];
        if (session !== undefined) void this.#controller.chooseSession(session.id);
      },
      () => this.#controller.closeSessionsPicker(),
    );
    this.#sessionsSelector = { generation: picker.generation, component };
    return component;
  }

  #selector(
    sessionId: string,
    epoch: string,
    dialog:
      | {
          readonly id: string;
          readonly method: "select";
          readonly title: string;
          readonly options: readonly string[];
        }
      | {
          readonly id: string;
          readonly method: "confirm";
          readonly title: string;
          readonly message: string;
        },
  ): ExtensionSelectorComponent {
    const key = `${sessionId}\0${epoch}\0${dialog.id}\0${dialog.method}`;
    const existing = this.#selectors.get(key);
    if (existing !== undefined) return existing;
    for (const existingKey of this.#selectors.keys())
      if (existingKey.startsWith(`${sessionId}\0`) && existingKey !== key)
        this.#selectors.delete(existingKey);
    const remoteOptions = dialog.method === "select" ? [...dialog.options] : ["Yes", "No"];
    const options =
      dialog.method === "select"
        ? remoteOptions.map((value, index) => `${index + 1}. ${redactRemoteLine(value)}`)
        : remoteOptions;
    const title =
      dialog.method === "confirm"
        ? `${redactRemoteLine(dialog.title)} — ${redactRemoteLine(dialog.message)}`
        : redactRemoteLine(dialog.title);
    const component = new ExtensionSelectorComponent(
      title,
      options,
      (value) => {
        if (dialog.method === "confirm")
          void this.#controller.answerExtensionUi(dialog.id, { confirmed: value === "Yes" });
        else {
          const selectedIndex = options.indexOf(value);
          const selectedValue = remoteOptions[selectedIndex];
          if (selectedValue !== undefined)
            void this.#controller.answerExtensionUi(dialog.id, { value: selectedValue });
        }
      },
      () => void this.#controller.answerExtensionUi(dialog.id, { cancelled: true }),
    );
    this.#selectors.set(key, component);
    return component;
  }

  #updateTerminalTitle(remoteTitle: string | undefined): void {
    const title = safeTerminalTitle(remoteTitle);
    if (title === this.#terminalTitle) return;
    this.#terminalTitle = title;
    this.#tui.terminal.setTitle(title);
  }

  async #submitEditor(text: string): Promise<void> {
    const selected = this.#controller.state.selectedSessionId;
    if (selected === undefined) return;
    const cache = this.#controller.state.cache(selected);
    const dialog = cache.live?.pendingUi.find((request) => isBlockingMethod(request.method));
    if (dialog?.method === "input" || dialog?.method === "editor") {
      cache.dialogDrafts.set(dialog.id, text);
      await this.#controller.answerExtensionUi(dialog.id, { value: text });
      return;
    }
    await this.#controller.submitText(text, false);
  }

  #syncEditor(): void {
    const selected = this.#controller.state.selectedSessionId;
    if (selected === undefined) {
      this.#editorTarget = "";
      return;
    }
    const cache = this.#controller.state.cache(selected);
    const dialog = cache.live?.pendingUi.find((request) => isBlockingMethod(request.method));
    const target =
      dialog === undefined ? `composer:${selected}` : `dialog:${selected}:${dialog.id}`;
    let desired = cache.draft;
    if (dialog?.method === "editor") {
      if (!cache.dialogDrafts.has(dialog.id))
        cache.dialogDrafts.set(dialog.id, dialog.prefill ?? "");
      desired = cache.dialogDrafts.get(dialog.id) ?? "";
    } else if (dialog?.method === "input") {
      if (!cache.dialogDrafts.has(dialog.id)) cache.dialogDrafts.set(dialog.id, "");
      desired = cache.dialogDrafts.get(dialog.id) ?? "";
    }
    if (target !== this.#editorTarget) this.#editorTarget = target;
    if (this.#editor.getText() !== desired) {
      this.#syncingEditor = true;
      this.#editor.setText(desired);
      this.#syncingEditor = false;
    }
  }
}
