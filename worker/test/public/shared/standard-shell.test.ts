import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { assert, describe, it } from "vitest";
import devicesHtml from "../../../public/auth/devices.html?raw";
import providersHtml from "../../../public/auth/providers.html?raw";
import sessionsHtml from "../../../public/sessions/index.html?raw";
import statsHtml from "../../../public/stats/index.html?raw";

const styles = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const devicesStyles = styles("../../../public/auth/devices.css");
const providersStyles = styles("../../../public/auth/providers.css");
const sessionsStyles = styles("../../../public/sessions/styles.css");
const sharedStyles = styles("../../../public/shared/styles.css");
const statsStyles = styles("../../../public/stats/styles.css");

const pages = [
  { current: "/sessions", html: sessionsHtml, ownerLinksHidden: true },
  { current: "/stats", html: statsHtml, ownerLinksHidden: true },
  { current: "/providers", html: providersHtml, ownerLinksHidden: false },
  { current: "/devices", html: devicesHtml, ownerLinksHidden: false },
];

const destinations = ["/sessions", "/stats", "/providers", "/devices"];

function shellRegion(html: string, mobile: boolean): string {
  const pattern = html.includes('class="sessions-rail"')
    ? /<nav class="rail-global"[\s\S]*?<\/nav>/u
    : mobile
      ? /<details class="mobile-utilities">[\s\S]*?<\/details>/u
      : /<nav class="masthead-nav"[\s\S]*?<\/nav>/u;
  const region = html.match(pattern)?.[0];
  assert.ok(region);
  return region;
}

function links(region: string) {
  return [...region.matchAll(/<a\b([^>]*)>([^<]+)<\/a>/gu)].map((match) => ({
    attributes: match[1] ?? "",
    label: match[2]?.trim(),
  }));
}

describe("standard application shell", () => {
  it("uses one identity and four-link navigation contract on desktop and mobile", () => {
    const identity = statsHtml.match(/<a class="identity"[\s\S]*?<\/a>/u)?.[0];
    assert.ok(identity);
    assert.match(sessionsHtml, /<a class="rail-brand"[\s\S]*?Scotty[\s\S]*?<\/a>/u);

    for (const page of pages) {
      assert.include(page.html, 'class="scotty-ui app-page standard-page');
    }
    for (const page of pages.slice(1)) {
      assert.strictEqual(page.html.match(/<a class="identity"[\s\S]*?<\/a>/u)?.[0], identity);
    }

    for (const page of pages) {
      for (const mobile of [false, true]) {
        const navigation = links(shellRegion(page.html, mobile));
        assert.deepStrictEqual(
          navigation.map((link) => link.attributes.match(/href="([^"]+)"/u)?.[1]),
          destinations,
        );
        assert.strictEqual(
          navigation.filter((link) => link.attributes.includes('aria-current="page"')).length,
          1,
        );
        const current = navigation.find((link) => link.attributes.includes('aria-current="page"'));
        assert.include(current?.attributes ?? "", `href="${page.current}"`);
      }
    }
  });

  it("keeps owner navigation hidden only on standard-client pages", () => {
    for (const page of pages) {
      for (const mobile of [false, true]) {
        const ownerLinks = links(shellRegion(page.html, mobile)).filter((link) =>
          ["Providers", "Devices"].includes(link.label ?? ""),
        );
        assert.strictEqual(ownerLinks.length, 2);
        assert.strictEqual(
          ownerLinks.every((link) => link.attributes.includes(" hidden")),
          page.ownerLinksHidden,
        );
      }
    }
  });

  it("names one standard width and centralizes active and focus treatment", () => {
    assert.include(sharedStyles, "--content-width-standard: 980px");
    assert.include(sharedStyles, "width: min(100%, var(--content-width-standard))");
    assert.include(sharedStyles, '.masthead-nav .button[aria-current="page"]');
    assert.include(sharedStyles, '.mobile-utilities nav a[aria-current="page"]');
    assert.include(sharedStyles, ".standard-page .identity:focus-visible");
    assert.include(sharedStyles, ".mobile-utilities summary:focus-visible");

    for (const styles of [sessionsStyles, statsStyles, providersStyles, devicesStyles]) {
      assert.notMatch(styles, /width:\s*min\(100%,\s*(?:920|980|1120)px\)/u);
    }
  });
});
