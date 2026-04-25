import { TokenManager } from "./auth.js";
import type { EnvConfig } from "./config.js";

/**
 * Build a `TokenManager` for the current run. Auto-refresh on cookie
 * expiry is not supported: when the cookie is rejected, the user must
 * re-run `tp authenticate` to obtain a fresh one. Passwords are never
 * persisted, environment-cached, or exchanged in the background.
 */
export function buildTokenManager(env: EnvConfig): TokenManager {
  return new TokenManager({ cookie: env.cookie });
}
