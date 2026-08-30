import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const sessionsStyles = await readFile(
  new URL("../worker/public/sessions/styles.css", import.meta.url),
  "utf8",
);

describe("sessions mobile layout", () => {
  it("keeps disclosure actions on one full-width row", () => {
    assert.match(
      sessionsStyles,
      /body\.sessions-page \.mobile-session-detail\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/u,
    );
    assert.match(
      sessionsStyles,
      /body\.sessions-page \.mobile-actions\s*\{[^}]*grid-area:\s*auto;[^}]*width:\s*100%;[^}]*flex-wrap:\s*nowrap;/u,
    );
    assert.match(
      sessionsStyles,
      /body\.sessions-page \.mobile-actions \.button\s*\{[^}]*min-height:\s*44px;[^}]*flex:\s*1 1 0;/u,
    );
  });
});
