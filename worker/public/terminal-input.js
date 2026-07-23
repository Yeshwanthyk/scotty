export const mobileKeyData = Object.freeze({
  escape: "\x1b",
  tab: "\t",
  interrupt: "\x03",
  enter: "\r",
  left: "\x1b[D",
  down: "\x1b[B",
  up: "\x1b[A",
  right: "\x1b[C",
});

export function terminalPrompt(value) {
  const normalized = value.replace(/\r\n?/gu, "\n");
  return normalized.trim().length > 0 ? normalized : undefined;
}

export function terminalFontSize(value, fallback = 14) {
  const parsed = typeof value === "string" && value.trim().length > 0 ? Number(value) : value;
  return Number.isFinite(parsed) ? clamp(Math.round(parsed), 12, 18) : fallback;
}

export function terminalCell(bounds, cols, rows, clientX, clientY) {
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  return {
    x: clamp(Math.floor(((clientX - bounds.left) / width) * cols) + 1, 1, cols),
    y: clamp(Math.floor(((clientY - bounds.top) / height) * rows) + 1, 1, rows),
  };
}

export function sgrMouse(button, cell, release = false) {
  return `\x1b[<${button};${cell.x};${cell.y}${release ? "m" : "M"}`;
}

export function wheelButton(deltaY) {
  return deltaY > 0 ? 65 : 64;
}

export function wheelSteps(deltaY, pixelsPerStep = 32) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  return clamp(Math.max(1, Math.round(Math.abs(deltaY) / pixelsPerStep)), 1, 5);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
