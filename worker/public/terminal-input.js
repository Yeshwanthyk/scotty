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
