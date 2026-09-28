import * as stylex from "@stylexjs/stylex";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import globalCss from "../global.css?url";
import { colors } from "../theme/tokens.stylex";
import { Layout } from "../components/Layout";
import scottyFavicon from "../assets/brand/scotty-favicon-32.png?url";
import scottyMark from "../assets/brand/scotty-mark-128.png?url";

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
      { name: "theme-color", content: "#fbfbfa", media: "(prefers-color-scheme: light)" },
      { name: "theme-color", content: "#121211", media: "(prefers-color-scheme: dark)" },
    ],
    links: [
      { rel: "icon", type: "image/png", sizes: "32x32", href: scottyFavicon },
      { rel: "apple-touch-icon", href: scottyMark },
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
      </head>
      <body {...stylex.props(styles.body)}>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
