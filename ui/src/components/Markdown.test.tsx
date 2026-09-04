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
