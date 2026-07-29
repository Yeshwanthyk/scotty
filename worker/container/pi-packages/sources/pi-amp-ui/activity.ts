export type WorkState = "idle" | "thinking" | "streaming" | "tool" | "compacting" | "queued";

export const ACTIVITY_FRAMES = ["∼", "≈", "≋", "≈", "∼"] as const;
export const ACTIVITY_INTERVAL_MS = 200;

type Timer = ReturnType<typeof setInterval>;
type Schedule = (callback: () => void, intervalMs: number) => Timer;
type Cancel = (timer: Timer) => void;

const ANIMATED_STATES = new Set<WorkState>(["thinking", "streaming", "tool", "compacting"]);

export class ActivityController {
  state: WorkState = "idle";
  frame = 0;
  tokens = 0;

  private readonly activeTools = new Map<string, string>();
  private readonly onChange: () => void;
  private readonly schedule: Schedule;
  private readonly cancel: Cancel;
  private timer: Timer | undefined;

  constructor(
    onChange: () => void,
    schedule: Schedule = setInterval,
    cancel: Cancel = clearInterval,
  ) {
    this.onChange = onChange;
    this.schedule = schedule;
    this.cancel = cancel;
  }

  get glyph(): string {
    return ACTIVITY_FRAMES[this.frame] ?? ACTIVITY_FRAMES[0];
  }

  get activeToolLabel(): string {
    if (this.activeTools.size === 1) return this.activeTools.values().next().value ?? "tool";
    return `${this.activeTools.size} tools`;
  }

  get label(): string {
    if (this.state === "idle") return "Idle";
    if (this.state === "queued") return "Queued Follow-Up";
    if (this.state === "tool") return `Running ${this.activeToolLabel}`;
    if (this.state === "compacting") return "Auto-Compacting";
    if (this.state === "streaming") return "Streaming";
    return "Thinking";
  }

  startAgent(): void {
    this.activeTools.clear();
    this.frame = 0;
    this.tokens = 0;
    this.transition("thinking");
  }

  updateMessage(eventType: string, reportedOutputTokens: number): void {
    if (reportedOutputTokens > 0) this.tokens = reportedOutputTokens;
    if (this.activeTools.size > 0) {
      this.onChange();
      return;
    }
    if (eventType.startsWith("thinking_")) this.transition("thinking");
    else if (eventType.startsWith("text_") || eventType.startsWith("toolcall_")) this.transition("streaming");
    else this.onChange();
  }

  completeMessage(reportedOutputTokens: number): void {
    this.tokens = Math.max(0, reportedOutputTokens);
    this.onChange();
  }

  startTool(toolCallId: string, toolName: string): void {
    this.activeTools.set(toolCallId, toolName);
    this.transition("tool");
  }

  endTool(toolCallId: string): void {
    this.activeTools.delete(toolCallId);
    this.transition(this.activeTools.size > 0 ? "tool" : "thinking");
  }

  transition(next: WorkState): void {
    this.state = next;
    this.syncTimer();
    this.onChange();
  }

  dispose(): void {
    this.stopTimer();
    this.activeTools.clear();
  }

  private syncTimer(): void {
    if (!ANIMATED_STATES.has(this.state)) {
      this.stopTimer();
      return;
    }
    if (this.timer) return;
    this.timer = this.schedule(() => {
      this.frame = (this.frame + 1) % ACTIVITY_FRAMES.length;
      this.onChange();
    }, ACTIVITY_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    this.cancel(this.timer);
    this.timer = undefined;
  }
}
