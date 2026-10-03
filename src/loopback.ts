import type * as cf from "@cloudflare/workers-types";

// ctx.exports.default is the Worker's host-provided loopback factory; props are decoded there.
export const isLoopback = (value: unknown): value is (options: { props: object }) => cf.Fetcher =>
  typeof value === "function";
