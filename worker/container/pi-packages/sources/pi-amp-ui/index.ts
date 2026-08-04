import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { ActivityController } from "./activity.ts";
import { TurnFold } from "./fold.ts";
import {
  compactPath,
  contextRailWidth,
  fitFrameBorder,
  parseGitDiffNumstat,
  terminalSafeFrameWidth,
  type GitDiffStats,
} from "./layout.ts";
import { formatProcessedTokens, summarizeSessionUsage } from "./usage.ts";

let requestRender: (() => void) | undefined;
let branch: string | undefined;
let gitDiff: GitDiffStats = { additions: 0, deletions: 0 };
let enabled = true;

const activity = new ActivityController(() => requestRender?.());
let uiTheme: Theme | undefined;
const fold = new TurnFold(() => uiTheme, () => requestRender?.());

function thinkingLabel(pi: ExtensionAPI): string {
  const level = pi.getThinkingLevel();
  return level === "off" ? "off" : level;
}

function stateLabel(theme: Theme): string {
  const tone = activity.state === "idle" ? "dim" : "muted";
  if (activity.state === "idle" || activity.state === "queued") {
    return theme.fg(tone, ` ${activity.label} `);
  }
  const tokens = activity.tokens > 0 && (activity.state === "thinking" || activity.state === "streaming")
    ? ` ${activity.tokens} tok`
    : "";
  return ` ${theme.fg("accent", activity.glyph)} ${theme.fg(tone, `${activity.label}${tokens}`)} `;
}

type ContextTone = "customMessageLabel" | "warning" | "error";

function contextTone(percent: number | undefined): ContextTone {
  if (percent != null && percent > 90) return "error";
  if (percent != null && percent > 70) return "warning";
  return "customMessageLabel";
}

function contextLabel(percent: number | undefined, theme: Theme): string {
  const amount = percent == null ? "?" : `${percent.toFixed(1)}%`;
  return theme.bold(theme.inverse(theme.fg(contextTone(percent), ` ${amount} `)));
}

function locationLabel(ctx: ExtensionContext, theme: Theme, width: number): string {
  const branchLabel = branch ? theme.fg("accent", ` ⎇ ${branch}`) : "";
  const additions = gitDiff.additions > 0 ? theme.fg("success", ` +${gitDiff.additions}`) : "";
  const deletions = gitDiff.deletions > 0 ? theme.fg("error", ` −${gitDiff.deletions}`) : "";
  const suffix = `${branchLabel}${additions}${deletions}`;
  const maxPath = Math.max(8, width - visibleWidth(suffix) - 4);
  const cwd = compactPath(ctx.cwd, homedir(), maxPath);
  return ` ${theme.fg("dim", cwd)}${suffix} `;
}

function isHorizontalBorder(line: string): boolean {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  return /^─+(?: [↑↓] \d+ more ─*)?$/.test(plain);
}

class AmpEditor extends CustomEditor {
  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
  ) {
    super(tui, editorTheme, keybindings, { paddingX: 1 });
    requestRender = () => tui.requestRender();
  }

  private get appTheme(): Theme {
    return this.ctx.ui.theme;
  }

  override render(width: number): string[] {
    const frameWidth = terminalSafeFrameWidth(width);
    const innerWidth = Math.max(1, frameWidth - 2);
    const lines = super.render(innerWidth);
    const bottomIndex = lines.findIndex((line, index) => index > 0 && isHorizontalBorder(line));
    if (bottomIndex < 1) return lines;

    const missingBodyRows = Math.max(0, 4 - bottomIndex);
    for (let index = 0; index < missingBodyRows; index++) {
      lines.splice(bottomIndex, 0, " ".repeat(innerWidth));
    }
    const adjustedBottom = lines.findIndex((line, index) => index > 0 && isHorizontalBorder(line));
    // Amp keeps the frame neutral; state color belongs in labels, not the chrome.
    const paint = (text: string) => this.appTheme.fg("text", text);
    const mode = thinkingLabel(this.pi);
    const model = this.ctx.model?.name ?? this.ctx.model?.id;
    const contextPercent = this.ctx.getContextUsage()?.percent;
    const sessionUsage = summarizeSessionUsage(
      this.ctx.sessionManager.getEntries(),
      this.ctx.sessionManager.getBranch(),
    );
    const usageLabels = [
      sessionUsage.processedTokens > 0
        ? this.appTheme.fg("muted", ` ${formatProcessedTokens(sessionUsage.processedTokens)} `)
        : "",
      sessionUsage.latestCacheHitPercent != null
        ? this.appTheme.fg(
            "muted",
            ` C ${Math.round(Math.min(100, Math.max(0, sessionUsage.latestCacheHitPercent)))} `,
          )
        : "",
    ].filter(Boolean);
    const chromeLabels = [
      contextLabel(contextPercent, this.appTheme),
      model ? this.appTheme.fg("accent", ` ${model} `) : "",
      this.appTheme.fg("syntaxType", ` ${mode} `),
    ].filter(Boolean);
    const separator = paint("─");
    const topRightWithUsage = [...usageLabels, ...chromeLabels].join(separator);
    const topRight = usageLabels.length > 0 && visibleWidth(topRightWithUsage) <= frameWidth - 3
      ? topRightWithUsage
      : chromeLabels.join(separator);
    const bottomLeft = stateLabel(this.appTheme);
    const bottomRight = locationLabel(this.ctx, this.appTheme, frameWidth);
    const railAvailable = Math.max(
      0,
      frameWidth - visibleWidth(bottomLeft) - visibleWidth(bottomRight) - 3,
    );
    const rail = this.appTheme.fg(
      contextTone(contextPercent),
      "─".repeat(contextRailWidth(contextPercent, railAvailable)),
    );

    lines[0] = fitFrameBorder("", topRight, frameWidth, paint, ["╭", "╮"]);
    lines[adjustedBottom] = fitFrameBorder(`${bottomLeft}${rail}`, bottomRight, frameWidth, paint, ["╰", "╯"]);
    for (let index = 1; index < adjustedBottom; index++) {
      const line = lines[index] ?? "";
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      lines[index] = `${paint("│")}${line}${padding}${paint("│")}`;
    }
    return lines;
  }
}

class EmptyFooter implements Component {
  render(): string[] {
    return [];
  }
  invalidate(): void {}
}

function installChrome(pi: ExtensionAPI, ctx: ExtensionContext): void {
  ctx.ui.setWorkingVisible(false);
  ctx.ui.setFooter(() => new EmptyFooter());
  ctx.ui.setHeader((_tui, theme) => ({
    render(width: number): string[] {
      if (width < 38) return [theme.fg("text", "Welcome to Pi · Amp Neo")];
      return [
        "",
        theme.fg("text", "Welcome to Pi") + theme.fg("dim", " · Amp Neo shell"),
        theme.fg("dim", "/ for commands  ·  ctrl+o for details  ·  alt+t for Amp-style details"),
        "",
      ];
    },
    invalidate() {},
  }));
  ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
    new AmpEditor(tui, editorTheme, keybindings, pi, ctx),
  );
}

function uninstallChrome(ctx: ExtensionContext): void {
  requestRender = undefined;
  ctx.ui.setHeader(undefined);
  ctx.ui.setFooter(undefined);
  ctx.ui.setEditorComponent(undefined);
  ctx.ui.setWorkingVisible(true);
}

async function refreshGitState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  try {
    const [branchResult, diffResult] = await Promise.all([
      pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd, timeout: 1000 }),
      pi.exec("git", ["diff", "--numstat", "HEAD", "--"], { cwd: ctx.cwd, timeout: 1000 }),
    ]);
    branch = branchResult.code === 0 ? branchResult.stdout.trim() || undefined : undefined;
    gitDiff = diffResult.code === 0
      ? parseGitDiffNumstat(diffResult.stdout)
      : { additions: 0, deletions: 0 };
  } catch {
    branch = undefined;
    gitDiff = { additions: 0, deletions: 0 };
  }
  requestRender?.();
}

export default function ampNeo(pi: ExtensionAPI): void {
  pi.registerCommand("amp", {
    description: "Toggle the Amp Neo-inspired Pi shell",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      enabled = value === "on" ? true : value === "off" ? false : !enabled;
      if (enabled) installChrome(pi, ctx);
      else uninstallChrome(ctx);
      ctx.ui.notify(`Amp Neo shell ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.registerShortcut("alt+t", {
    description: "Expand or collapse tool and activity details",
    handler: (ctx) => ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded()),
  });

  pi.registerShortcut("ctrl+shift+o", {
    description: "Toggle folding of settled turns",
    handler: () => {
      fold.toggle();
    },
  });

  pi.registerCommand("fold", {
    description: "Toggle collapsing settled turns to summary + final response",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Turn folding ${fold.toggle() ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    activity.transition("idle");
    uiTheme = ctx.ui.theme;
    if (ctx.mode === "tui") {
      fold.install();
      // On /reload pi rebuilds the transcript before extensions re-bind, so
      // adopt already-rendered components via the TUI root.
      ctx.ui.setWidget("amp-fold-probe", (tui) => {
        queueMicrotask(() => fold.adopt(tui));
        return { render: () => [], invalidate() {} };
      });
    }
    if (enabled && ctx.mode === "tui") installChrome(pi, ctx);
    void refreshGitState(pi, ctx);
  });

  pi.on("agent_start", () => {
    activity.startAgent();
    fold.startRun();
  });
  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    activity.updateMessage(event.assistantMessageEvent.type, event.message.usage.output);
  });
  pi.on("tool_execution_start", (event) => {
    activity.startTool(event.toolCallId, event.toolName);
  });
  pi.on("tool_execution_end", (event) => {
    activity.endTool(event.toolCallId);
  });
  pi.on("session_before_compact", () => activity.transition("compacting"));
  pi.on("session_compact", () => activity.transition("idle"));
  pi.on("input", (event) => {
    if (event.streamingBehavior === "steer") activity.transition("thinking");
  });
  pi.on("agent_end", (_event, ctx) => activity.transition(ctx.hasPendingMessages() ? "queued" : "idle"));
  pi.on("agent_settled", () => {
    activity.transition("idle");
    fold.settleRun();
  });
  pi.on("model_select", () => requestRender?.());
  pi.on("thinking_level_select", () => requestRender?.());
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") activity.completeMessage(event.message.usage.output);
    requestRender?.();
  });
  pi.on("tool_result", (event, ctx) => {
    if (["write", "edit", "bash"].includes(event.toolName)) void refreshGitState(pi, ctx);
  });
  pi.on("session_shutdown", () => {
    activity.dispose();
    fold.uninstall();
    requestRender = undefined;
  });
}
