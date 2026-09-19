import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useState } from "react";
import { colors, spacing } from "../theme/tokens.stylex";

const styles = stylex.create({
  figure: {
    margin: `0 0 ${spacing.lg}`,
    minWidth: 0,
    border: `1px solid ${colors.line}`,
    borderRadius: "8px",
    backgroundColor: colors.control,
    overflow: "hidden",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${spacing.sm} ${spacing.md}`,
    borderBottom: `1px solid ${colors.lineSoft}`,
    color: colors.muted,
    fontSize: "12px",
  },
  button: {
    backgroundColor: "transparent",
    border: `1px solid ${colors.line}`,
    borderRadius: "5px",
    color: colors.ink,
    padding: "5px 9px",
    cursor: "pointer",
    ":hover": { backgroundColor: colors.panelRaised },
  },
  viewport: { overflow: "auto", padding: spacing.lg },
  image: { display: "block", width: "100%", height: "auto" },
  enlarged: { width: "max(100%, 1000px)", maxWidth: "none" },
  status: { padding: spacing.md, margin: 0, color: colors.muted, fontSize: "13px" },
  source: {
    padding: `${spacing.sm} ${spacing.md}`,
    borderTop: `1px solid ${colors.lineSoft}`,
    color: colors.muted,
    fontSize: "12px",
  },
  summary: { cursor: "pointer", paddingBlock: spacing.xs },
  code: {
    overflowX: "auto",
    whiteSpace: "pre",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    lineHeight: 1.6,
  },
});

// Rendered SVGs are displayed as images so diagram content cannot join the app DOM.
const renderer = () =>
  import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      htmlLabels: false,
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "suppressErrorRendering",
        "htmlLabels",
        "theme",
        "themeVariables",
        "fontFamily",
      ],
      themeVariables: {
        darkMode: true,
        background: "#101010",
        primaryColor: "#202b2e",
        primaryTextColor: "#f5f5f5",
        primaryBorderColor: "#64949d",
        secondaryColor: "#242424",
        tertiaryColor: "#181818",
        lineColor: "#a6b6ba",
        textColor: "#f5f5f5",
        nodeTextColor: "#f5f5f5",
        mainBkg: "#202b2e",
        edgeLabelBackground: "#101010",
        actorBkg: "#202b2e",
        actorBorder: "#64949d",
        actorTextColor: "#f5f5f5",
        actorLineColor: "#a6b6ba",
        signalColor: "#a6b6ba",
        signalTextColor: "#f5f5f5",
        labelBoxBkgColor: "#242424",
        labelTextColor: "#f5f5f5",
        noteBkgColor: "#242424",
        noteTextColor: "#f5f5f5",
      },
    });
    return mermaid;
  });
let mermaidRenderer: ReturnType<typeof renderer> | undefined;

export function MermaidDiagram({ source }: { readonly source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [result, setResult] = useState<{ readonly source: string; readonly image?: string }>();
  const [enlarged, setEnlarged] = useState(false);
  const current = result?.source === source ? result : undefined;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      mermaidRenderer ??= renderer();
      void mermaidRenderer
        .then(async (mermaid) => {
          if (cancelled) return;
          const container = document.createElement("div");
          container.style.position = "fixed";
          container.style.visibility = "hidden";
          container.style.pointerEvents = "none";
          container.setAttribute("aria-hidden", "true");
          document.body.append(container);
          try {
            const { svg } = await mermaid.render(`mermaid-${id}`, source, container);
            if (!cancelled)
              setResult({
                source,
                image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
              });
          } finally {
            container.remove();
          }
        })
        .catch(() => {
          if (!cancelled) setResult({ source });
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, source]);

  return (
    <figure data-mermaid {...stylex.props(styles.figure)}>
      <figcaption {...stylex.props(styles.toolbar)}>
        <span>Mermaid diagram</span>
        {current?.image === undefined ? null : (
          <button
            type="button"
            aria-pressed={enlarged}
            onClick={() => setEnlarged(!enlarged)}
            {...stylex.props(styles.button)}
          >
            {enlarged ? "Fit diagram" : "Enlarge"}
          </button>
        )}
      </figcaption>
      {current?.image === undefined ? (
        <p role="status" {...stylex.props(styles.status)}>
          {current === undefined
            ? "Rendering diagram…"
            : "Diagram preview unavailable. The source may be incomplete or invalid."}
        </p>
      ) : (
        <div
          role="region"
          aria-label="Mermaid diagram"
          tabIndex={0}
          {...stylex.props(styles.viewport)}
        >
          <img
            alt="Mermaid diagram; text description available in diagram source below"
            src={current.image}
            {...stylex.props(styles.image, enlarged && styles.enlarged)}
          />
        </div>
      )}
      <details
        open={current !== undefined && current.image === undefined ? true : undefined}
        {...stylex.props(styles.source)}
      >
        <summary {...stylex.props(styles.summary)}>Diagram source</summary>
        <pre {...stylex.props(styles.code)}>
          <code>{source}</code>
        </pre>
      </details>
    </figure>
  );
}
