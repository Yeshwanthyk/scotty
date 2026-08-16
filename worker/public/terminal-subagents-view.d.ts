import type { SubagentActivitySnapshot, SubagentDetail } from "./terminal-subagents-projection.js";
export declare function encodeSubagentSteerArguments(
  child: SubagentDetail,
  revision: number,
  message: string,
): string;

export declare function renderSubagentList(
  document: Document,
  snapshot: SubagentActivitySnapshot | undefined,
  onSelect: (id: string) => void,
): HTMLElement;
export declare function renderSubagentDetail(
  document: Document,
  child: SubagentDetail,
  onBack: () => void,
  onSteer?: (message: string) => void,
): HTMLElement;
export declare function renderSelectedSubagent(
  document: Document,
  snapshot: SubagentActivitySnapshot | undefined,
  selectedId: string | undefined,
  onBack: () => void,
  onSteer?: (message: string) => void,
): HTMLElement;
