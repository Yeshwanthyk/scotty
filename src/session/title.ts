// The first line of the prompt, cut at a word near 60 characters.
export const titleFrom = (prompt: string) => {
  const line = prompt.trim().split("\n")[0] ?? "";
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
};
