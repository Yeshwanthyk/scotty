import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";
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
  // Never larger than it was drawn: a tall, narrow flowchart stretched to the column is huge.
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

// Pele reads its colors from CSS variables; an <img> can't inherit them, so each render writes them into the SVG.
const palette = (dark: boolean) =>
  dark
    ? {
        bg: "#161616",
        fg: "#ececec",
        muted: "#a1a1a1",
        line: "#8a8a8a",
        surface: "#232323",
        "surface-alt": "#1c1c1c",
        border: "#4a4a4a",
        accent: "#8aa4e8",
      }
    : {
        bg: "#ffffff",
        fg: "#1d1d1f",
        muted: "#6e6e76",
        line: "#6e6e76",
        surface: "#f4f4f5",
        "surface-alt": "#fafafa",
        border: "#c9c9ce",
        accent: "#5b7bd5",
      };

const fontFamily = "ui-sans-serif, system-ui, sans-serif";

const themed = (svg: string, dark: boolean) => {
  const vars = Object.entries(palette(dark))
    .map(([name, value]) => `--pele-${name}:${value};`)
    .join("");
  return svg.replace(/^<svg([^>]*?) style="/, `<svg$1 style="${vars}`);
};

// Rendered SVGs are displayed as images so diagram content cannot join the app DOM.
// `pele/lazy` loads only the module for the diagram type it meets.
const renderer = () => import("pele/lazy");
let peleRenderer: ReturnType<typeof renderer> | undefined;

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

// The width the diagram may fill (the figure less the viewport's padding), so wide flowcharts
// turn vertical on a phone.
function useWidth() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.max(0, Math.floor(entry.contentRect.width) - 32));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width] as const;
}

export function MermaidDiagram({ source }: { readonly source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [result, setResult] = useState<{
    readonly source: string;
    readonly image?: string;
    readonly width?: number;
  }>();
  const [enlarged, setEnlarged] = useState(false);
  const dark = useDark();
  const [measure, width] = useWidth();
  const current = result?.source === source ? result : undefined;
  const drawn = useRef(false);

  useEffect(() => {
    if (width === undefined) return;
    let cancelled = false;
    const draw = () => {
      peleRenderer ??= renderer();
      void peleRenderer
        .then((pele) =>
          pele.renderAsync(source, {
            idPrefix: `diagram-${id}`,
            fontFamily,
            fontSize: 14,
            maxWidth: width,
            responsive: false,
            links: false,
            images: false,
          }),
        )
        .then(({ svg, width: drawnWidth }) => {
          if (cancelled) return;
          drawn.current = true;
          setResult({
            source,
            image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(themed(svg, dark))}`,
            width: Math.ceil(drawnWidth),
          });
        })
        .catch(() => {
          if (cancelled) return;
          drawn.current = true;
          setResult({ source });
        });
    };
    // The first draw is immediate; while a reply streams, redraws wait for the source to settle.
    const timer = drawn.current ? setTimeout(draw, 150) : undefined;
    if (timer === undefined) draw();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, source, dark, width]);

  return (
    <figure data-mermaid ref={measure} {...stylex.props(styles.figure)}>
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
