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
