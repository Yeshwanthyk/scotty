interface Env {
  readonly M01B_SYNTHETIC_SECRET: unknown;
}

/** Runtime proof deliberately tests presence only; it never coerces or logs the binding. */
export const accountSecretsStoreCanaryFetch = (_request: Request, env: Partial<Env>): Response =>
  Response.json({ bound: env.M01B_SYNTHETIC_SECRET !== undefined });

export default { fetch: accountSecretsStoreCanaryFetch };
