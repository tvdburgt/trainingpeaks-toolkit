import { TokenManager, AuthError } from "./auth.js";
import { log } from "./util/log.js";
import { USER_AGENT } from "./util/http.js";

const TP_BASE = "https://tpapi.trainingpeaks.com";
const MIN_REQUEST_INTERVAL_MS = 150;

export class APIError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "APIError";
  }
}

export class NotFoundError extends APIError {
  constructor(message: string) {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class TPClient {
  private lastRequest = 0;

  constructor(private readonly tokens: TokenManager) {}

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = MIN_REQUEST_INTERVAL_MS - (now - this.lastRequest);
    if (wait > 0) await sleep(wait);
    this.lastRequest = Date.now();
  }

  async get<T>(endpoint: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const url = this.buildUrl(endpoint, params);
    return this.requestJSON<T>("GET", url);
  }

  async post<T>(
    endpoint: string,
    body: unknown,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = this.buildUrl(endpoint, params);
    return this.requestJSON<T>("POST", url, true, 3, body);
  }

  private buildUrl(endpoint: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(endpoint.startsWith("http") ? endpoint : `${TP_BASE}${endpoint}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async requestJSON<T>(
    method: string,
    url: string,
    retryOn401 = true,
    retriesLeft = 3,
    body?: unknown,
  ): Promise<T> {
    await this.throttle();
    const token = await this.tokens.getAccessToken();

    log.debug(`${method} ${url}`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await fetch(url, init);

    if (res.status === 401 && retryOn401) {
      log.debug("401 received, invalidating token and retrying once");
      this.tokens.invalidate();
      return this.requestJSON<T>(method, url, false, retriesLeft, body);
    }

    if (res.status === 401) {
      throw new AuthError(
        "Authorization failed after retry. Your session may be expired — refresh the cookie.",
      );
    }

    if (res.status === 404) {
      throw new NotFoundError(`Not found: ${url}`);
    }

    if (res.status === 429) {
      if (retriesLeft > 0) {
        const backoff = (4 - retriesLeft) ** 2 * 1000 + 500;
        log.warn(`Rate limited, backing off ${backoff}ms`);
        await sleep(backoff);
        return this.requestJSON<T>(method, url, retryOn401, retriesLeft - 1, body);
      }
      throw new APIError("Rate limit exceeded", 429);
    }

    if (res.status >= 500 && retriesLeft > 0) {
      const backoff = (4 - retriesLeft) ** 2 * 1000 + 500;
      log.warn(`HTTP ${res.status}, backing off ${backoff}ms`);
      await sleep(backoff);
      return this.requestJSON<T>(method, url, retryOn401, retriesLeft - 1, body);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new APIError(
        `HTTP ${res.status} ${res.statusText} for ${url}${body ? ` — ${body.slice(0, 300)}` : ""}`,
        res.status,
        body,
      );
    }

    // 204 No Content
    if (res.status === 204) return undefined as unknown as T;

    const text = await res.text();
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new APIError(`Invalid JSON from ${url}`, res.status);
    }
  }
}
