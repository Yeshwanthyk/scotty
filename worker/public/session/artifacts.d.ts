export type Artifact =
  | { readonly kind: "unavailable"; readonly label: string; readonly reference?: string }
  | {
      readonly kind: "evidence";
      readonly reference: string;
      readonly jobId: string;
      readonly label: string;
      readonly status: string;
      readonly completedSteps: number;
      readonly frameCount: number;
      readonly video: boolean;
      readonly failure?: { readonly code: string; readonly step?: number };
      readonly href: string;
    }
  | {
      readonly kind: "hatch";
      readonly reference: string;
      readonly hatchId: string;
      readonly label: string;
      readonly status: string;
      readonly available: boolean;
      readonly href?: string;
    };
export declare function artifactForTool(tool: unknown, sessionId: string): Artifact | undefined;
export declare function renderArtifactCard(document: Document, artifact: Artifact): HTMLElement;
