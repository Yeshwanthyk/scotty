import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const sessionsStyles = await readFile(
  new URL("../worker/public/sessions/styles.css", import.meta.url),
  "utf8",
);

describe("sessions mobile layout", () => {
  it("keeps the session rail full-width with one bounded list scroller", () => {
    assert.match(
      sessionsStyles,
      /body\.sessions-page \.rail-repositories\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/u,
    );
    assert.match(
      sessionsStyles,
      /@media \(max-width: 760px\)[\s\S]*?body\.sessions-page \.sessions-app\s*\{[^}]*display:\s*block;/u,
    );
    assert.match(
      sessionsStyles,
      /@media \(max-width: 760px\)[\s\S]*?body\.sessions-page \.sessions-rail\s*\{[^}]*width:\s*100%;[^}]*height:\s*100dvh;/u,
    );
  });
});
