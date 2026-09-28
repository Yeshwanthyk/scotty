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
  // Never larger than mermaid drew it: a tall, narrow flowchart stretched to the column is huge.
  image: { display: "block", maxWidth: "100%", height: "auto", marginInline: "auto" },
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

const palette = (dark: boolean) =>
  dark
    ? {
        bg: "#161616",
        node: "#232323",
        border: "#4a4a4a",
        line: "#8a8a8a",
        text: "#ececec",
        soft: "#1c1c1c",
      }
    : {
        bg: "#ffffff",
        node: "#f4f4f5",
        border: "#c9c9ce",
        line: "#6e6e76",
        text: "#1d1d1f",
        soft: "#fafafa",
      };

// Mermaid's config is global, so each render sets it for the scheme it draws in.
const configure = (mermaid: typeof import("mermaid").default, dark: boolean) => {
  const color = palette(dark);
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
      darkMode: dark,
      // Mermaid 12's base theme glows every node; flat reads calmer.
      dropShadow: "none",
      fontSize: "14px",
      background: color.bg,
      primaryColor: color.node,
      primaryTextColor: color.text,
      primaryBorderColor: color.border,
      secondaryColor: color.soft,
      tertiaryColor: color.soft,
      lineColor: color.line,
      textColor: color.text,
      nodeTextColor: color.text,
      mainBkg: color.node,
      edgeLabelBackground: color.bg,
      actorBkg: color.node,
      actorBorder: color.border,
      actorTextColor: color.text,
      actorLineColor: color.line,
      signalColor: color.line,
      signalTextColor: color.text,
      labelBoxBkgColor: color.soft,
      labelTextColor: color.text,
      noteBkgColor: color.soft,
      noteTextColor: color.text,
    },
  });
};

// Rendered SVGs are displayed as images so diagram content cannot join the app DOM.
const renderer = () => import("mermaid").then(({ default: mermaid }) => mermaid);

// The drawn width, from the viewBox mermaid writes on its root <svg>.
const naturalWidth = (svg: string) => {
  const box = /viewBox="[\d.-]+ [\d.-]+ ([\d.]+) [\d.]+"/.exec(svg);
  const width = Number(box?.[1]);
  return Number.isFinite(width) && width > 0 ? Math.ceil(width) : undefined;
};

const darkQuery = "(prefers-color-scheme: dark)";
function useDark() {
  const [dark, setDark] = useState(
    () => typeof window !== "undefined" && window.matchMedia(darkQuery).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(darkQuery);
    const onChange = () => setDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return dark;
}
let mermaidRenderer: ReturnType<typeof renderer> | undefined;

export function MermaidDiagram({ source }: { readonly source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [result, setResult] = useState<{
    readonly source: string;
    readonly image?: string;
    readonly width?: number;
  }>();
  const [enlarged, setEnlarged] = useState(false);
  const dark = useDark();
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
            configure(mermaid, dark);
            const { svg } = await mermaid.render(`mermaid-${id}`, source, container);
            if (!cancelled)
              setResult({
                source,
                image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
                width: naturalWidth(svg),
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
  }, [id, source, dark]);

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
            width={current.width}
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
