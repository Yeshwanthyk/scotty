import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const render = (source: string): string => renderToStaticMarkup(<Markdown source={source} />);

describe("Markdown", () => {
  it("renders assistant structure as semantic markup", () => {
    const output = render("## Driver contract\n\n- **Neutral** boundary\n- `Codex` adapter");

    expect(output).toContain("<h2");
    expect(output).toContain("<ul");
    expect(output).toContain("<strong>Neutral</strong>");
    expect(output).toContain("<code");
  });

  it("renders raw HTML and images as inert text", () => {
    const output = render('<script>alert("no")</script>\n\n![alt](https://example.com/a.png)');

    expect(output).not.toContain("<script>");
    expect(output).not.toContain("<img");
    expect(output).toContain("&lt;script&gt;");
    expect(output).toContain("![alt](https://example.com/a.png)");
  });

  it("blocks executable links", () => {
    const output = render("[unsafe](javascript:alert(1))");

    expect(output).not.toContain("href=");
    expect(output).toContain("unsafe");
  });

  it("isolates external links", () => {
    const output = render("[docs](https://platform.openai.com/docs)");

    expect(output).toContain('href="https://platform.openai.com/docs"');
    expect(output).toContain('target="_blank"');
    expect(output).toContain('rel="noopener noreferrer"');
  });
});

describe("Markdown technical blocks", () => {
  it("keeps table semantics, alignment, and a keyboard-accessible scroll region", () => {
    const output = render("| Candidate | Added |\n| :--- | ---: |\n| **Browser vault** | Sep 10 |");
    expect(output).toContain('aria-label="Scrollable table"');
    expect(output).toContain('tabindex="0"');
    expect(output).toContain('scope="col"');
    expect(output).toContain("<thead>");
    expect(output).toContain("<tbody>");
    expect(output).toContain("<strong>Browser vault</strong>");
    expect(output).toContain("Sep 10");
  });

  it("renders Mermaid fences with source available before the client renderer loads", () => {
    const output = render("```mermaid\nflowchart LR\n  A --> B\n```");
    expect(output).toContain("data-mermaid");
    expect(output).toContain("Rendering diagram");
    expect(output).toContain("Diagram source");
    expect(output).toContain("A --&gt; B");
  });

  it("keeps ordinary code and potentially executable diagram source inert", () => {
    const code = render("```typescript\nconst diagram = 'mermaid';\n```");
    const diagram = render("```mermaid\n<script>alert(1)</script>\n```");
    expect(code).not.toContain("data-mermaid");
    expect(code).toContain("<pre");
    expect(diagram).not.toContain("<script>");
    expect(diagram).toContain("&lt;script&gt;");
  });
});
