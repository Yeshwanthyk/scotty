import * as stylex from "@stylexjs/stylex";
import { createContext, useContext, useState } from "react";
import type { EvidenceSummary } from "../data/session-workbench";
import { colors, spacing } from "../theme/tokens.stylex";

export type MarkdownEvidence =
  | { readonly kind: "loading"; readonly sessionId: string }
  | {
      readonly kind: "ready";
      readonly sessionId: string;
      readonly evidence: ReadonlyArray<EvidenceSummary>;
    }
  | { readonly kind: "error"; readonly sessionId: string; readonly message: string };

export const MarkdownImageContext = createContext<{
  readonly sessionId?: string;
  readonly evidence?: MarkdownEvidence;
}>({});

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const reference = /^scotty-evidence:([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u;

export function markdownEvidenceReferences(source: string): ReadonlyArray<string> {
  return Array.from(
    source.matchAll(/scotty-evidence:([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?![A-Za-z0-9_-])/gu),
    (match) => match[0],
  );
}

export function resolveMarkdownImage(
  href: string,
  sessionId: string | undefined,
  evidence: MarkdownEvidence | undefined,
):
  | { readonly kind: "available"; readonly src: string }
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly reason: string } {
  const jobId = href.match(reference)?.[1];
  if (jobId === undefined)
    return {
      kind: "unavailable",
      reason: "Only screenshots published to this session can be displayed.",
    };
  if (sessionId === undefined || !identifier.test(sessionId))
    return { kind: "unavailable", reason: "This image needs its original session." };
  if (evidence === undefined || evidence.sessionId !== sessionId || evidence.kind === "loading")
    return { kind: "loading" };
  if (evidence.kind === "error")
    return { kind: "unavailable", reason: "Screenshot details could not be loaded." };
  const job = evidence.evidence.find((candidate) => candidate.jobId === jobId);
  const frameId = job?.steps.find((step) => step.frameId !== undefined)?.frameId;
  if (frameId === undefined || !identifier.test(frameId))
    return {
      kind: "unavailable",
      reason: "No published screenshot is available for this reference.",
    };
  return {
    kind: "available",
    src: `/s/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(jobId)}/frames/${encodeURIComponent(frameId)}.png`,
  };
}

const styles = stylex.create({
  image: {
    display: "block",
    maxWidth: "100%",
    height: "auto",
    marginBlock: spacing.sm,
    borderRadius: "6px",
    outline: `1px solid ${colors.lineSoft}`,
    outlineOffset: "-1px",
  },
  status: { display: "block", color: colors.muted, fontSize: "13px", overflowWrap: "anywhere" },
});

function PublishedImage({
  src,
  alt,
  title,
}: {
  readonly src: string;
  readonly alt: string;
  readonly title?: string;
}) {
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  return (
    <span data-markdown-image={state}>
      {state === "error" ? (
        <span role="status" {...stylex.props(styles.status)}>
          Image unavailable: {alt || "Screenshot"}. It may have expired or access may have changed.
        </span>
      ) : (
        <>
          <img
            src={src}
            alt={alt}
            title={title}
            loading="lazy"
            decoding="async"
            onLoad={() => setState("loaded")}
            onError={() => setState("error")}
            {...stylex.props(styles.image)}
          />
          {state === "loading" ? (
            <span role="status" {...stylex.props(styles.status)}>
              Loading image…
            </span>
          ) : null}
        </>
      )}
    </span>
  );
}

export function MarkdownImage({
  href,
  alt,
  title,
}: {
  readonly href: string;
  readonly alt: string;
  readonly title?: string;
}) {
  const { sessionId, evidence } = useContext(MarkdownImageContext);
  const resolved = resolveMarkdownImage(href, sessionId, evidence);
  if (resolved.kind === "available")
    return <PublishedImage key={resolved.src} src={resolved.src} alt={alt} title={title} />;
  return (
    <span role="status" data-markdown-image={resolved.kind} {...stylex.props(styles.status)}>
      {resolved.kind === "loading"
        ? `Loading image: ${alt || "Screenshot"}…`
        : `Image unavailable: ${alt || "Screenshot"}. ${resolved.reason}`}
    </span>
  );
}
