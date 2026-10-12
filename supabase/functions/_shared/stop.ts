// The emergency stop (GO-LIVE-RUNBOOK). In a production environment, MM_MODE=mock means: no call to
// MortgageMAX from anywhere, and no new application. Every vendor-facing action in both functions
// asks this first, so a stop can never leave records advancing on mock answers that staff would
// later run a real credit check on. A MISSING MMAX_ENV counts as production (fail closed); only the
// named test values accept any mode (UAT work runs MM_MODE=mock against MMAX_ENV=uat every day).
export function productionStopped(mode: "live" | "mock"): boolean {
  const env = (Deno.env.get("MMAX_ENV") ?? "").trim();
  const testEnv = /^(uat|test|sandbox|dev)$/i.test(env);
  return !testEnv && mode !== "live";
}

/** The refusal every stopped action returns; the pages show it as a service problem, never as the client's fault. */
export const STOPPED = { code: "config_error", message: "MortgageMAX calls are stopped (MM_MODE is not live in production)" } as const;
