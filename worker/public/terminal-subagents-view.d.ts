import type { SubagentActivitySnapshot, SubagentDetail } from "./terminal-subagents-projection.js";
export declare function renderSubagentList(
  document: Document,
  snapshot: SubagentActivitySnapshot | undefined,
  onSelect: (id: string) => void,
): HTMLElement;
export declare function renderSubagentDetail(
  document: Document,
  child: SubagentDetail,
  onBack: () => void,
): HTMLElement;
export declare function renderSelectedSubagent(
  document: Document,
  snapshot: SubagentActivitySnapshot | undefined,
  selectedId: string | undefined,
  onBack: () => void,
): HTMLElement;
