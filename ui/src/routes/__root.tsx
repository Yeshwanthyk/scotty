import * as stylex from "@stylexjs/stylex";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import globalCss from "../global.css?url";
import { colors } from "../theme/tokens.stylex";
import scottyFavicon from "../../../worker/public/brand/scotty-favicon-32.png?url";
import scottyMark from "../../../worker/public/brand/scotty-mark-128.png?url";

const styles = stylex.create({
  body: {
    minHeight: "100vh",
    margin: 0,
    backgroundColor: colors.space,
    color: colors.ink,
  },
});

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Scotty" },
    ],
    links: [
      { rel: "icon", type: "image/png", sizes: "32x32", href: scottyFavicon },
      { rel: "apple-touch-icon", href: scottyMark },
      { rel: "stylesheet", href: globalCss },
      ...(import.meta.env.DEV ? [{ rel: "stylesheet", href: "/virtual:stylex.css" }] : []),
    ],
  }),
  shellComponent: RootDocument,
  component: Outlet,
});

function RootDocument() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body {...stylex.props(styles.body)}>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
