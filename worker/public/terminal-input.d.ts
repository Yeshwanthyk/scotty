export interface TerminalBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TerminalCell {
  readonly x: number;
  readonly y: number;
}

export type MobileKey = "escape" | "tab" | "interrupt" | "enter" | "left" | "down" | "up" | "right";

export const mobileKeyData: Readonly<Record<MobileKey, string>>;
export function terminalPrompt(value: string): string | undefined;

export function terminalFontSize(value: unknown, fallback?: number): number;

export function terminalCell(
  bounds: TerminalBounds,
  cols: number,
  rows: number,
  clientX: number,
  clientY: number,
): TerminalCell;
export function sgrMouse(button: number, cell: TerminalCell, release?: boolean): string;
export function wheelButton(deltaY: number): 64 | 65;
export function wheelSteps(deltaY: number, pixelsPerStep?: number): number;
