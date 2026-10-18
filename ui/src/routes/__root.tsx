import * as stylex from "@stylexjs/stylex";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import globalCss from "../global.css?url";
import { colors } from "../theme/tokens.stylex";
import { Layout } from "../components/Layout";
import scottyFavicon from "../assets/brand/scotty-favicon-32.png?url";
import scottyTouch from "../assets/brand/scotty-mark-180.png?url";

const styles = stylex.create({
  body: {
    backgroundColor: colors.space,
    color: colors.ink,
  },
});

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
      },
      { title: "Scotty" },
      // Opened from the home screen it runs without browser chrome; the layout pads the status bar
      // with env(safe-area-inset-*).
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: "Scotty" },
    ],
    links: [
      { rel: "icon", type: "image/png", sizes: "32x32", href: scottyFavicon },
      { rel: "apple-touch-icon", sizes: "180x180", href: scottyTouch },
      // Cloudflare Access guards the whole host: without cookies the manifest gets its redirect.
      { rel: "manifest", href: "/manifest.webmanifest", crossOrigin: "use-credentials" },
      { rel: "stylesheet", href: globalCss },
      ...(import.meta.env.DEV ? [{ rel: "stylesheet", href: "/virtual:stylex.css" }] : []),
    ],
  }),
  shellComponent: RootDocument,
  component: Layout,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* Here, not in `head`: HeadContent keeps only the last meta of each name. */}
        <meta name="theme-color" content="#fbfbfa" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#121211" media="(prefers-color-scheme: dark)" />
      </head>
      <body {...stylex.props(styles.body)}>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
