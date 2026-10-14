import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

if (import.meta.env.DEV && typeof window !== "undefined") {
  void import("virtual:stylex:runtime");
}

// The session list is the top level; every other page sits one step in. On a phone that reads
// as pushing a page on and popping it off; sending from the new-session page carries the box
// over. Changes that keep the path, such as a query, don't animate.
const depth = (path: string) => (["/", "/sessions"].includes(path.replace(/(.)\/$/, "$1")) ? 0 : 1);
function transitionTypes({
  fromLocation,
  toLocation,
  pathChanged,
}: {
  fromLocation?: { pathname: string };
  toLocation: { pathname: string };
  pathChanged: boolean;
}): Array<string> | false {
  if (!pathChanged || fromLocation === undefined) return false;
  const from = fromLocation.pathname;
  const to = toLocation.pathname;
  if (from.startsWith("/sessions/create") && to.startsWith("/s/")) return ["compose"];
  const step = depth(to) - depth(from);
  return [step > 0 ? "push" : step < 0 ? "pop" : "swap"];
}

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultViewTransition: { types: transitionTypes },
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
