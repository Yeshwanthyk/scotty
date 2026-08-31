export interface PatchLine {
  readonly text: string;
  readonly kind: "addition" | "context" | "deletion" | "hunk" | "meta";
}

export type SplitPatchRow =
  | {
      readonly kind: "pair";
      readonly old?: PatchLine;
      readonly next?: PatchLine;
    }
  | {
      readonly kind: "hunk" | "meta";
      readonly line: PatchLine;
    };

export function parsePatchLines(patch: unknown): ReadonlyArray<PatchLine>;
export function splitPatchRows(lines: ReadonlyArray<PatchLine>): ReadonlyArray<SplitPatchRow>;

export function createChangesViewer(options: {
  readonly document: Document;
  readonly fetch: typeof globalThis.fetch;
  readonly headerActions: Element;
}): {
  readonly setSessionId: (sessionId: string | undefined) => void;
  readonly dispose: () => void;
};
