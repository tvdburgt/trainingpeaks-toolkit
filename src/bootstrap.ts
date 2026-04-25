import { TokenManager } from "./auth.js";
import type { EnvConfig } from "./config.js";
import { loginForCookie } from "./login.js";
import { updateEnvFile } from "./io/env.js";
import { log } from "./util/log.js";

/**
 * Build a `TokenManager` wired up for automatic cookie refresh on expiry.
 *
 * Refresher fires when the token endpoint rejects the current cookie. It
 * requires both `username` and `password` to be present in the env config:
 *
 *   - Username is read from `.env` (`TP_USERNAME`, written by `tp init`).
 *   - Password is read from the `TP_PASSWORD` environment variable. We
 *     deliberately do NOT persist passwords to disk by default.
 *
 * If either is missing, we omit the refresher and the existing AuthError
 * surface is preserved (user is told to run `tp authenticate`).
 *
 * On successful refresh, the new cookie is written back to `.env` via the
 * persistence hook, so subsequent runs start from a fresh cookie.
 */
export function buildTokenManager(env: EnvConfig): TokenManager {
  const canRefresh = Boolean(env.username && env.password);
  if (!canRefresh) {
    return new TokenManager({ cookie: env.cookie });
  }

  const username = env.username!;
  const password = env.password!;

  return new TokenManager({
    cookie: env.cookie,
    refresher: () => loginForCookie(username, password),
    onCookieRefreshed: async (cookie) => {
      await updateEnvFile(env.projectRoot, { TP_COOKIE: cookie });
      log.debug("Persisted refreshed TP_COOKIE to .env");
    },
  });
}
