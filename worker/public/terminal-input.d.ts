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

export interface VisualViewportMetrics {
  readonly width: number;
  readonly height: number;
  readonly offsetTop: number;
  readonly offsetLeft: number;
}

export interface VisualViewportFrame {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export type MobileKey = "escape" | "tab" | "interrupt" | "enter";

export const mobileKeyData: Readonly<Record<MobileKey, string>>;
export function terminalPrompt(value: string): string | undefined;

export function terminalFontSize(value: unknown, fallback?: number): number;
export function visualViewportFrame(
  viewport: Partial<VisualViewportMetrics> | undefined,
  fallbackWidth: number,
  fallbackHeight: number,
  keyboardOpen?: boolean,
): VisualViewportFrame;

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
