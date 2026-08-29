export type Artifact =
  | { readonly kind: "unavailable"; readonly label: string }
  | {
      readonly kind: "evidence";
      readonly label: string;
      readonly status: string;
      readonly completedSteps: number;
      readonly frameCount: number;
      readonly video: boolean;
      readonly href: string;
    }
  | {
      readonly kind: "hatch";
      readonly label: string;
      readonly status: string;
      readonly available: boolean;
      readonly href?: string;
    };
export declare function artifactForTool(tool: unknown, sessionId: string): Artifact | undefined;
export declare function renderArtifactCard(document: Document, artifact: Artifact): HTMLElement;
