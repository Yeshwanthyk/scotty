const TERMINAL_KEY_SEQUENCES = Object.freeze({
  escape: "\u001b",
  tab: "\t",
  "ctrl-c": "\u0003",
  "arrow-up": "\u001b[A",
  "arrow-down": "\u001b[B",
  "arrow-right": "\u001b[C",
  "arrow-left": "\u001b[D",
});

export function composerText(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/gu, "\n");
  return normalized.trim().length > 0 ? normalized : undefined;
}

export function terminalKeySequence(action) {
  return TERMINAL_KEY_SEQUENCES[action];
}

export function submitComposer(terminal, value) {
  const text = composerText(value);
  if (!text) return false;
  terminal.paste(text);
  terminal.input("\r", true);
  return true;
}

export function sendTerminalKey(terminal, action) {
  const sequence = terminalKeySequence(action);
  if (!sequence) return false;
  terminal.input(sequence, true);
  return true;
}
