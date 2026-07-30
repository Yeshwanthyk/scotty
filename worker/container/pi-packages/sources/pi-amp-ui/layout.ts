import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type Paint = (text: string) => string;

export interface GitDiffStats {
  additions: number;
  deletions: number;
}

export function terminalSafeFrameWidth(terminalWidth: number): number {
  // Keep the final terminal column empty. Some terminal emulators leave the
  // cursor in pending-wrap after painting it, so Pi's next differential render
  // starts one physical row lower and leaks the previous frame into scrollback.
  return Math.max(1, terminalWidth - 1);
}

export function contextRailWidth(percent: number | undefined, availableWidth: number): number {
  if (percent == null || availableWidth <= 0) return 0;
  const ratio = Math.min(100, Math.max(0, percent)) / 100;
  if (ratio === 0) return 0;
  return Math.min(availableWidth, Math.max(1, Math.round(availableWidth * ratio)));
}

export function parseGitDiffNumstat(output: string): GitDiffStats {
  let additions = 0;
  let deletions = 0;

  for (const line of output.split("\n")) {
    const [added, deleted] = line.split("\t", 2);
    const addedCount = Number.parseInt(added ?? "", 10);
    const deletedCount = Number.parseInt(deleted ?? "", 10);
    if (Number.isFinite(addedCount)) additions += addedCount;
    if (Number.isFinite(deletedCount)) deletions += deletedCount;
  }

  return { additions, deletions };
}

export function fitFrameBorder(
  left: string,
  right: string,
  width: number,
  paint: Paint,
  corners: readonly [string, string],
): string {
  if (width <= 0) return "";
  if (width === 1) return paint(corners[0]);

  const innerWidth = width - 2;
  let leftText = left;
  let rightText = right;
  const gap = 1;

  while (visibleWidth(leftText) + visibleWidth(rightText) + gap > innerWidth && visibleWidth(rightText) > 0) {
    rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
  }
  while (visibleWidth(leftText) + visibleWidth(rightText) + gap > innerWidth && visibleWidth(leftText) > 0) {
    leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
  }

  const fillWidth = Math.max(0, innerWidth - visibleWidth(leftText) - visibleWidth(rightText));
  return `${paint(corners[0])}${leftText}${paint("─".repeat(fillWidth))}${rightText}${paint(corners[1])}`;
}

export function joinResponsive(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const available = Math.max(0, width - visibleWidth(left) - 1);
  const fittedRight = truncateToWidth(right, available, "");
  if (!fittedRight) return truncateToWidth(left, width, "");
  const padding = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(fittedRight)));
  return truncateToWidth(`${left}${padding}${fittedRight}`, width, "");
}

export function compactPath(cwd: string, home: string | undefined, maxWidth: number): string {
  const homePath = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (visibleWidth(homePath) <= maxWidth) return homePath;
  return `…${homePath.slice(-(Math.max(1, maxWidth - 1)))}`;
}
