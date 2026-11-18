import type * as cf from "@cloudflare/workers-types";

export const isLoopback = (value: unknown): value is (options: { props: object }) => cf.Fetcher =>
  typeof value === "function";
