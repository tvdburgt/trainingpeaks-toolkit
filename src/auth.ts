import { log } from "./util/log.js";
import { USER_AGENT } from "./util/http.js";

const TP_BASE = "https://tpapi.trainingpeaks.com";
const TOKEN_ENDPOINT = "/users/v3/token";
const REFRESH_BUFFER_SECONDS = 60;

interface TokenResponse {
  success?: boolean;
  token?: {
    access_token: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
  };
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch seconds
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Optional hooks that let the toolkit recover from an expired
 * `Production_tpAuth` cookie without manual user intervention.
 *
 * - `refresher`: called when the current cookie is rejected by the token
 *   endpoint. Must return a fresh `Production_tpAuth` cookie value (typically
 *   by calling `loginForCookie` with stored credentials).
 * - `onCookieRefreshed`: invoked after a refresher succeeds, so callers can
 *   persist the new cookie back to disk (e.g. rewrite `.env`).
 */
export interface TokenManagerHooks {
  refresher?: () => Promise<string>;
  onCookieRefreshed?: (cookie: string) => Promise<void>;
}

export class TokenManager {
  private cached: CachedToken | undefined;
  private pending: Promise<string> | undefined;
  private cookie: string;
  private readonly refresher: TokenManagerHooks["refresher"];
  private readonly onCookieRefreshed: TokenManagerHooks["onCookieRefreshed"];

  /**
   * Accepts either a bare cookie (legacy) or `{ cookie, refresher?, onCookieRefreshed? }`.
   */
  constructor(arg: string | ({ cookie: string } & TokenManagerHooks)) {
    if (typeof arg === "string") {
      this.cookie = arg;
      this.refresher = undefined;
      this.onCookieRefreshed = undefined;
    } else {
      this.cookie = arg.cookie;
      this.refresher = arg.refresher;
      this.onCookieRefreshed = arg.onCookieRefreshed;
    }
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (
      !forceRefresh &&
      this.cached &&
      now < this.cached.expiresAt - REFRESH_BUFFER_SECONDS
    ) {
      return this.cached.accessToken;
    }
    if (this.pending) return this.pending;

    this.pending = this.exchangeWithRefresh()
      .then((tok) => {
        this.cached = tok;
        return tok.accessToken;
      })
      .finally(() => {
        this.pending = undefined;
      });

    return this.pending;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  /**
   * Exchange the current cookie for a token. If the exchange fails with a
   * recognised auth error and a `refresher` hook is configured, log in
   * fresh, swap the cookie, persist it, and retry exactly once.
   */
  private async exchangeWithRefresh(): Promise<CachedToken> {
    try {
      return await this.exchange();
    } catch (err) {
      if (!(err instanceof AuthError) || !this.refresher) throw err;

      log.info("Cookie expired, refreshing…");
      const fresh = await this.refresher();
      this.cookie = fresh;
      if (this.onCookieRefreshed) {
        try {
          await this.onCookieRefreshed(fresh);
        } catch (persistErr) {
          // Persistence failure is non-fatal — the in-memory cookie still
          // works for this run; user will just see another refresh next run.
          log.warn(`Could not persist refreshed cookie: ${(persistErr as Error).message}`);
        }
      }
      const tok = await this.exchange();
      log.info("Refreshed.");
      return tok;
    }
  }

  private async exchange(): Promise<CachedToken> {
    const url = `${TP_BASE}${TOKEN_ENDPOINT}`;
    log.debug(`Exchanging cookie for access token: ${url}`);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Cookie: `Production_tpAuth=${this.cookie}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });

    if (res.status === 401) {
      throw new AuthError(
        "Cookie rejected by TrainingPeaks (401). Re-copy the `Production_tpAuth` cookie from your browser into .env.",
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // TP returns 500 for malformed/expired cookies too, not always 401.
      const looksLikeAuthFailure =
        res.status === 500 || res.status === 403;
      if (looksLikeAuthFailure) {
        throw new AuthError(
          `Token exchange rejected (HTTP ${res.status}). Your cookie is likely invalid or expired — re-copy Production_tpAuth from app.trainingpeaks.com into .env.`,
        );
      }
      throw new AuthError(
        `Token exchange failed: HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ""}`,
      );
    }

    const body = (await res.json()) as TokenResponse;
    const token = body.token;
    if (!token || !token.access_token) {
      throw new AuthError("Token exchange returned no access_token.");
    }

    const expiresIn = typeof token.expires_in === "number" ? token.expires_in : 3600;
    return {
      accessToken: token.access_token,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    };
  }
}
