export interface TerminalInputTarget {
  paste(data: string): void;
  input(data: string, wasUserInput?: boolean): void;
}

export type TerminalKeyAction =
  | "escape"
  | "tab"
  | "ctrl-c"
  | "arrow-up"
  | "arrow-down"
  | "arrow-right"
  | "arrow-left";

export function composerText(value: unknown): string | undefined;
export function terminalKeySequence(action: unknown): string | undefined;
export function submitComposer(terminal: TerminalInputTarget, value: unknown): boolean;
export function sendTerminalKey(terminal: TerminalInputTarget, action: unknown): boolean;
