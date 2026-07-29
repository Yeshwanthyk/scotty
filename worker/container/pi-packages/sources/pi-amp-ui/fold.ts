import {
  AssistantMessageComponent,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, type Component } from "@earendil-works/pi-tui";

export type TurnStats = {
  tools: number;
  messages: number;
  failures: number;
  aborted: boolean;
  durationMs: number | undefined;
};

type Group = {
  components: Component[];
  startedAt: number;
  endedAt?: number;
  sawRun: boolean;
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function formatSummary(stats: TurnStats): string {
  const parts: string[] = [];
  if (stats.durationMs !== undefined) parts.push(`Worked for ${formatDuration(stats.durationMs)}`);
  if (stats.tools > 0) parts.push(`${stats.tools} ${stats.tools === 1 ? "tool" : "tools"}`);
  if (stats.messages > 0) parts.push(`${stats.messages} ${stats.messages === 1 ? "msg" : "msgs"}`);
  if (stats.failures > 0) parts.push(`${stats.failures} ${stats.failures === 1 ? "failure" : "failures"}`);
  if (stats.aborted) parts.push("interrupted");
  return `▶ ${parts.join(" · ")}`;
}

function assistantMessage(component: Component): Record<string, unknown> | undefined {
  const message: unknown = Reflect.get(component, "lastMessage");
  return typeof message === "object" && message !== null
    ? (message as Record<string, unknown>)
    : undefined;
}

function hasVisibleContent(message: Record<string, unknown> | undefined): boolean {
  if (!Array.isArray(message?.content)) return false;
  return message.content.some((item: unknown) => {
    if (typeof item !== "object" || item === null) return false;
    const { type, text, thinking } = item as { type?: string; text?: string; thinking?: string };
    if (type === "text") return Boolean(text?.trim());
    if (type === "thinking") return Boolean(thinking?.trim());
    return false;
  });
}

function hasTerminalNotice(message: Record<string, unknown> | undefined): boolean {
  const stopReason = message?.stopReason;
  if (stopReason === "length") return true;
  if (stopReason !== "aborted" && stopReason !== "error") return false;
  const content = Array.isArray(message?.content) ? message.content : [];
  const hasToolCalls = content.some(
    (item: unknown) => (item as { type?: string } | null)?.type === "toolCall",
  );
  return !hasToolCalls;
}

export class TurnFold {
  enabled = true;

  private running = false;
  private current: Group | undefined;
  private groups: Group[] = [];
  private groupByComponent = new WeakMap<Component, Group>();
  private seenUserComponents = new WeakSet<Component>();
  private restorePatches: (() => void) | undefined;

  private readonly getTheme: () => Theme | undefined;
  private readonly requestRender: () => void;

  constructor(getTheme: () => Theme | undefined, requestRender: () => void) {
    this.getTheme = getTheme;
    this.requestRender = requestRender;
  }

  install(): void {
    if (this.restorePatches) return;
    // Pi has no whole-turn transcript API, so group components as the
    // interactive mode adds them to its chat container, and override how
    // grouped assistant/tool rows render.
    const fold = this;
    const containerPrototype = Container.prototype;
    const originalAddChild = containerPrototype.addChild;
    const assistantPrototype = AssistantMessageComponent.prototype;
    const originalAssistantRender = assistantPrototype.render;
    const toolPrototype = ToolExecutionComponent.prototype;
    const originalToolRender = toolPrototype.render;

    const patchedAddChild = function (this: Container, component: Component): void {
      originalAddChild.call(this, component);
      fold.track(component);
    };
    const patchedAssistantRender = function (
      this: AssistantMessageComponent,
      width: number,
    ): string[] {
      return fold.renderFolded(this, width, () => originalAssistantRender.call(this, width));
    };
    const patchedToolRender = function (this: ToolExecutionComponent, width: number): string[] {
      return fold.renderFolded(this, width, () => originalToolRender.call(this, width));
    };

    containerPrototype.addChild = patchedAddChild;
    assistantPrototype.render = patchedAssistantRender;
    toolPrototype.render = patchedToolRender;
    this.restorePatches = () => {
      if (containerPrototype.addChild === patchedAddChild) {
        containerPrototype.addChild = originalAddChild;
      }
      if (assistantPrototype.render === patchedAssistantRender) {
        assistantPrototype.render = originalAssistantRender;
      }
      if (toolPrototype.render === patchedToolRender) {
        toolPrototype.render = originalToolRender;
      }
    };
  }

  uninstall(): void {
    this.restorePatches?.();
    this.restorePatches = undefined;
  }

  /**
   * Group components that were rendered before the patches were installed.
   * On /reload, pi rebuilds the transcript before extensions re-bind, so the
   * addChild patch misses the history; walk the live component tree instead.
   */
  adopt(root: Container): void {
    this.current = undefined;
    this.groups = [];
    this.groupByComponent = new WeakMap();
    this.seenUserComponents = new WeakSet();
    const walk = (container: Container): void => {
      for (const child of container.children) {
        this.track(child);
        if (
          child instanceof Container &&
          !(child instanceof UserMessageComponent) &&
          !(child instanceof SkillInvocationMessageComponent) &&
          !(child instanceof AssistantMessageComponent) &&
          !(child instanceof ToolExecutionComponent)
        ) {
          walk(child);
        }
      }
    };
    walk(root);
    for (const group of this.groups) this.invalidateGroup(group);
    this.requestRender();
  }

  startRun(): void {
    this.running = true;
    if (this.current) this.current.sawRun = true;
  }

  settleRun(): void {
    this.running = false;
    if (this.current) {
      this.current.endedAt ??= Date.now();
      this.invalidateGroup(this.current);
    }
    this.requestRender();
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    for (const group of this.groups) this.invalidateGroup(group);
    this.requestRender();
    return this.enabled;
  }

  private track(component: Component): void {
    if (
      component instanceof UserMessageComponent ||
      component instanceof SkillInvocationMessageComponent
    ) {
      if (this.seenUserComponents.has(component)) return;
      this.seenUserComponents.add(component);
      // A skill invocation and its trailing user message share one turn.
      if (this.current && this.current.components.length === 0) return;
      if (this.current) this.current.endedAt ??= this.current.sawRun ? Date.now() : undefined;
      this.current = { components: [], startedAt: Date.now(), sawRun: this.running };
      this.groups.push(this.current);
      return;
    }
    if (
      !(component instanceof AssistantMessageComponent) &&
      !(component instanceof ToolExecutionComponent)
    ) {
      return;
    }
    if (this.groupByComponent.has(component)) return;
    if (!this.current) {
      this.current = { components: [], startedAt: Date.now(), sawRun: this.running };
      this.groups.push(this.current);
    }
    this.current.components.push(component);
    this.groupByComponent.set(component, this.current);
  }

  private renderFolded(component: Component, width: number, original: () => string[]): string[] {
    const group = this.groupByComponent.get(component);
    if (!group || !this.enabled) return original();
    if (group === this.current && this.running) return original();

    const anchor = this.finalAnchor(group);
    const lines: string[] = [];
    if (component === group.components[0]) {
      lines.push(...this.summaryLines(group, anchor, width));
    }
    if (component === anchor) lines.push(...original());
    return lines;
  }

  private finalAnchor(group: Group): Component | undefined {
    for (let index = group.components.length - 1; index >= 0; index--) {
      const component = group.components[index];
      if (!(component instanceof AssistantMessageComponent)) continue;
      const message = assistantMessage(component);
      if (hasVisibleContent(message) || hasTerminalNotice(message)) return component;
    }
    for (let index = group.components.length - 1; index >= 0; index--) {
      const component = group.components[index];
      if (component instanceof ToolExecutionComponent) return component;
    }
    return undefined;
  }

  private stats(group: Group): TurnStats {
    let tools = 0;
    let messages = 0;
    let failures = 0;
    let aborted = false;
    for (const component of group.components) {
      if (component instanceof ToolExecutionComponent) {
        tools += 1;
        const result = Reflect.get(component, "result") as { isError?: boolean } | undefined;
        if (result?.isError) failures += 1;
      } else if (component instanceof AssistantMessageComponent) {
        const message = assistantMessage(component);
        if (hasVisibleContent(message) || hasTerminalNotice(message)) messages += 1;
        if (message?.stopReason === "aborted") aborted = true;
      }
    }
    const durationMs =
      group.sawRun && group.endedAt !== undefined
        ? Math.max(0, group.endedAt - group.startedAt)
        : undefined;
    return { tools, messages, failures, aborted, durationMs };
  }

  private summaryLines(group: Group, anchor: Component | undefined, width: number): string[] {
    if (width <= 0) return [];
    const stats = this.stats(group);
    const hidden = stats.tools + stats.messages - (anchor ? 1 : 0);
    if (hidden <= 0 && !stats.aborted && stats.failures === 0) return [];
    const text = truncateToWidth(formatSummary(stats), width, "…");
    const theme = this.getTheme();
    const styled = theme
      ? theme.bold(theme.fg(stats.aborted || stats.failures > 0 ? "warning" : "muted", text))
      : text;
    return ["", styled];
  }

  private invalidateGroup(group: Group): void {
    for (const component of group.components) component.invalidate?.();
  }
}
