import * as stylex from "@stylexjs/stylex";
import { Marked, type MarkedToken, type Token, type Tokens } from "marked";
import { createElement, Fragment, type ReactNode } from "react";
import { colors, spacing } from "../theme/tokens.stylex";

const markdown = new Marked({ breaks: false, gfm: true, pedantic: false });
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const BASE_URL = "https://scotty.invalid/";
const KNOWN_TOKEN_TYPES = new Set([
  "blockquote",
  "br",
  "checkbox",
  "code",
  "codespan",
  "def",
  "del",
  "em",
  "escape",
  "heading",
  "hr",
  "html",
  "image",
  "link",
  "list",
  "list_item",
  "paragraph",
  "space",
  "strong",
  "table",
  "text",
]);

const styles = stylex.create({
  root: { maxWidth: "68ch", color: colors.ink, fontSize: "14px", lineHeight: 1.7 },
  paragraph: { margin: `0 0 ${spacing.md}`, textWrap: "pretty" },
  lastBlock: { marginBottom: 0 },
  heading: {
    margin: `${spacing.xl} 0 ${spacing.sm}`,
    color: colors.ink,
    fontWeight: 680,
    lineHeight: 1.25,
    letterSpacing: "-0.015em",
    textWrap: "balance",
  },
  heading1: { fontSize: "22px" },
  heading2: { fontSize: "19px" },
  heading3: { fontSize: "16px" },
  headingMinor: { fontSize: "14px" },
  list: {
    margin: `0 0 ${spacing.md}`,
    paddingLeft: "1.4em",
  },
  listItem: { paddingLeft: "0.2em", marginBlock: "3px" },
  blockquote: {
    margin: `0 0 ${spacing.md}`,
    paddingLeft: spacing.lg,
    borderLeftWidth: "2px",
    borderLeftStyle: "solid",
    borderLeftColor: colors.lineHover,
    color: colors.muted,
  },
  inlineCode: {
    padding: "2px 5px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.lineSoft,
    borderRadius: "5px",
    backgroundColor: colors.panelRaised,
    color: colors.ink,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.88em",
  },
  codeBlock: {
    margin: `0 0 ${spacing.lg}`,
    padding: spacing.lg,
    overflowX: "auto",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.lineSoft,
    borderRadius: "8px",
    backgroundColor: colors.control,
    color: colors.muted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "12px",
    lineHeight: 1.6,
    whiteSpace: "pre",
  },
  link: {
    color: colors.focus,
    textDecorationLine: "underline",
    textDecorationColor: "rgb(126 217 232 / 0.42)",
    textUnderlineOffset: "3px",
    transitionProperty: "color, text-decoration-color",
    transitionDuration: "120ms",
    ":hover": { color: colors.ink, textDecorationColor: colors.ink },
  },
  raw: {
    color: colors.quiet,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.9em",
  },
  rule: { margin: `${spacing.xl} 0`, border: 0, borderTop: `1px solid ${colors.lineSoft}` },
  tableWrap: { marginBottom: spacing.lg, overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "13px" },
  tableCell: {
    padding: `${spacing.sm} ${spacing.md}`,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
    textAlign: "left",
    verticalAlign: "top",
  },
  tableHead: { color: colors.muted, fontWeight: 650 },
  alignCenter: { textAlign: "center" },
  alignRight: { textAlign: "right" },
});

const isKnownToken = (token: Token): token is MarkedToken => KNOWN_TOKEN_TYPES.has(token.type);
const knownTokens = (tokens: readonly Token[] | undefined): ReadonlyArray<MarkedToken> =>
  tokens?.filter(isKnownToken) ?? [];

const compactLinkTarget = (href: string): string =>
  Array.from(href)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x20 && (codePoint < 0x7f || codePoint > 0x9f);
    })
    .join("");

const safeLink = (
  href: string,
): { readonly href: string; readonly external: boolean } | undefined => {
  const normalizedHref = compactLinkTarget(href).replace(/&(?:colon|#(?:0*58|x0*3a));/giu, ":");
  const scheme = normalizedHref.match(/^([a-z][a-z\d+.-]*):/iu)?.[1]?.toLowerCase();
  if (scheme !== undefined && !SAFE_PROTOCOLS.has(`${scheme}:`)) return undefined;
  try {
    const base = new URL(BASE_URL);
    const destination = new URL(href, base);
    if (!SAFE_PROTOCOLS.has(destination.protocol)) return undefined;
    return { href, external: destination.origin !== base.origin };
  } catch {
    return undefined;
  }
};

const renderInline = (tokens: readonly Token[] | undefined): ReadonlyArray<ReactNode> =>
  knownTokens(tokens).map((token, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "text" || token.type === "escape")
      return <Fragment key={key}>{token.text}</Fragment>;
    if (token.type === "strong") return <strong key={key}>{renderInline(token.tokens)}</strong>;
    if (token.type === "em") return <em key={key}>{renderInline(token.tokens)}</em>;
    if (token.type === "del") return <del key={key}>{renderInline(token.tokens)}</del>;
    if (token.type === "codespan")
      return (
        <code key={key} {...stylex.props(styles.inlineCode)}>
          {token.text}
        </code>
      );
    if (token.type === "br") return <br key={key} />;
    if (token.type === "link") {
      const destination = safeLink(token.href);
      if (destination === undefined)
        return (
          <span key={key} {...stylex.props(styles.raw)}>
            {renderInline(token.tokens)}
          </span>
        );
      return (
        <a
          href={destination.href}
          key={key}
          rel={destination.external ? "noopener noreferrer" : undefined}
          target={destination.external ? "_blank" : undefined}
          title={token.title ?? undefined}
          {...stylex.props(styles.link)}
        >
          {renderInline(token.tokens)}
        </a>
      );
    }
    if (token.type === "html" || token.type === "image")
      return (
        <span key={key} {...stylex.props(styles.raw)}>
          {token.raw}
        </span>
      );
    return (
      <Fragment key={key}>
        {"tokens" in token && token.tokens !== undefined
          ? renderInline(token.tokens)
          : "text" in token
            ? token.text
            : token.raw}
      </Fragment>
    );
  });

const tableCell = (cell: Tokens.TableCell, tag: "td" | "th", key: string): ReactNode =>
  createElement(
    tag,
    {
      key,
      ...stylex.props(
        styles.tableCell,
        tag === "th" && styles.tableHead,
        cell.align === "center" && styles.alignCenter,
        cell.align === "right" && styles.alignRight,
      ),
    },
    renderInline(cell.tokens),
  );

function renderList(token: Tokens.List, key: string, isLast: boolean): ReactNode {
  const Tag = token.ordered ? "ol" : "ul";
  return (
    <Tag
      key={key}
      start={token.ordered && typeof token.start === "number" ? token.start : undefined}
      {...stylex.props(styles.list, isLast && styles.lastBlock)}
    >
      {token.items.map((item, itemIndex) => (
        <li key={`${key}-${itemIndex}`} {...stylex.props(styles.listItem)}>
          {renderBlocks(item.tokens, !item.loose)}
        </li>
      ))}
    </Tag>
  );
}

function renderTable(token: Tokens.Table, key: string, isLast: boolean): ReactNode {
  return (
    <div
      key={key}
      data-scrollbar="quiet"
      {...stylex.props(styles.tableWrap, isLast && styles.lastBlock)}
    >
      <table {...stylex.props(styles.table)}>
        <thead>
          <tr>
            {token.header.map((cell, cellIndex) => tableCell(cell, "th", `${key}-h-${cellIndex}`))}
          </tr>
        </thead>
        <tbody>
          {token.rows.map((row, rowIndex) => (
            <tr key={`${key}-r-${rowIndex}`}>
              {row.map((cell, cellIndex) =>
                tableCell(cell, "td", `${key}-${rowIndex}-${cellIndex}`),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderProseBlock(
  token: MarkedToken,
  key: string,
  isLast: boolean,
  tight: boolean,
): ReactNode | undefined {
  if (token.type === "heading")
    return createElement(
      `h${Math.min(6, Math.max(1, token.depth))}`,
      {
        key,
        ...stylex.props(
          styles.heading,
          token.depth === 1 && styles.heading1,
          token.depth === 2 && styles.heading2,
          token.depth === 3 && styles.heading3,
          token.depth >= 4 && styles.headingMinor,
        ),
      },
      renderInline(token.tokens),
    );
  if (token.type === "paragraph")
    return (
      <p key={key} {...stylex.props(styles.paragraph, isLast && styles.lastBlock)}>
        {renderInline(token.tokens)}
      </p>
    );
  if (token.type === "text") {
    const content = renderInline(token.tokens ?? [token]);
    return tight ? (
      <Fragment key={key}>{content}</Fragment>
    ) : (
      <p key={key} {...stylex.props(styles.paragraph, isLast && styles.lastBlock)}>
        {content}
      </p>
    );
  }
  if (token.type === "list") return renderList(token, key, isLast);
  if (token.type === "blockquote")
    return (
      <blockquote key={key} {...stylex.props(styles.blockquote, isLast && styles.lastBlock)}>
        {renderBlocks(token.tokens)}
      </blockquote>
    );
  return undefined;
}

function renderTechnicalBlock(token: MarkedToken, key: string, isLast: boolean): ReactNode {
  if (token.type === "code")
    return (
      <pre
        key={key}
        data-scrollbar="quiet"
        {...stylex.props(styles.codeBlock, isLast && styles.lastBlock)}
      >
        <code>{token.text}</code>
      </pre>
    );
  if (token.type === "table") return renderTable(token, key, isLast);
  if (token.type === "hr") return <hr key={key} {...stylex.props(styles.rule)} />;
  return (
    <p key={key} {...stylex.props(styles.paragraph, styles.raw, isLast && styles.lastBlock)}>
      {token.raw}
    </p>
  );
}

function renderBlocks(
  tokens: readonly Token[] | undefined,
  tight = false,
): ReadonlyArray<ReactNode> {
  const blocks = knownTokens(tokens).filter(
    (token) => token.type !== "space" && token.type !== "def",
  );
  return blocks.map((token, index) => {
    const key = `${token.type}-${index}`;
    const isLast = index === blocks.length - 1;
    return renderProseBlock(token, key, isLast, tight) ?? renderTechnicalBlock(token, key, isLast);
  });
}

export function Markdown({ source }: { readonly source: string }) {
  return (
    <div data-markdown {...stylex.props(styles.root)}>
      {renderBlocks(markdown.lexer(source))}
    </div>
  );
}
