import { log } from "./util/log.js";
import { USER_AGENT } from "./util/http.js";

/**
 * Programmatic TrainingPeaks login. Posts username/password to the public
 * login form (`home.trainingpeaks.com/login`), follows the redirect chain,
 * and harvests the `Production_tpAuth` session cookie that the rest of the
 * toolkit consumes.
 *
 * Pure Node — no headless browser, no third-party HTTP client. Works on
 * headless Linux. The login page renders an invisible reCAPTCHA v3, but the
 * server-side enforcement is advisory: posting `CaptchaHidden=true` with an
 * empty `CaptchaToken` is accepted (verified empirically; see
 * scripts/probe-login.ts).
 */

const LOGIN_URL = "https://home.trainingpeaks.com/login";
const APP_HOST = "app.trainingpeaks.com";
const MAX_REDIRECT_HOPS = 10;
const SESSION_COOKIE = "Production_tpAuth";

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
}

/**
 * Minimal RFC-6265-ish cookie jar. Scoped to what TP's login flow actually
 * uses (a couple of cookies on a couple of hosts) — not a general-purpose
 * implementation. Keyed by (domain, path, name) so a cookie reissued on the
 * same path overwrites cleanly.
 */
class CookieJar {
  private cookies = new Map<string, CookieEntry>();

  ingest(setCookieHeaders: string[], requestHost: string): void {
    for (const raw of setCookieHeaders) {
      const parsed = parseSetCookie(raw, requestHost);
      if (!parsed) continue;
      const key = `${parsed.domain}|${parsed.path}|${parsed.name}`;
      this.cookies.set(key, parsed);
    }
  }

  /** Build a `Cookie:` header value for a request to (host, path). */
  header(host: string, pathname: string): string {
    const parts: string[] = [];
    for (const c of this.cookies.values()) {
      if (!domainMatches(host, c.domain)) continue;
      if (!pathMatches(pathname, c.path)) continue;
      parts.push(`${c.name}=${c.value}`);
    }
    return parts.join("; ");
  }

  get(name: string): string | undefined {
    for (const c of this.cookies.values()) {
      if (c.name === name) return c.value;
    }
    return undefined;
  }
}

function parseSetCookie(raw: string, requestHost: string): CookieEntry | null {
  const parts = raw.split(/;\s*/);
  const first = parts.shift();
  if (!first) return null;
  const eq = first.indexOf("=");
  if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  let domain = requestHost.toLowerCase();
  let path = "/";
  for (const attr of parts) {
    const [k, v = ""] = attr.split("=");
    const key = k.trim().toLowerCase();
    if (key === "domain" && v) domain = v.trim().toLowerCase().replace(/^\./, "");
    else if (key === "path" && v) path = v.trim();
  }
  return { name, value, domain, path };
}

function domainMatches(host: string, cookieDomain: string): boolean {
  host = host.toLowerCase();
  cookieDomain = cookieDomain.toLowerCase();
  return host === cookieDomain || host.endsWith("." + cookieDomain);
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (reqPath.startsWith(cookiePath)) {
    return cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/";
  }
  return false;
}

/** Read all `Set-Cookie` headers from a response, even if undici split them. */
function getSetCookieHeaders(res: Response): string[] {
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const all = res.headers.get("set-cookie");
  return all ? [all] : [];
}

function extractRequestVerificationToken(html: string): string | null {
  // The hidden input may have name= before value= or vice-versa.
  const a = /name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i.exec(html);
  if (a) return a[1];
  const b = /value=["']([^"']+)["'][^>]*name=["']__RequestVerificationToken["']/i.exec(html);
  return b ? b[1] : null;
}

function looksLikeLoginForm(html: string): boolean {
  return /name=["']login-form["']/i.test(html) || /id=["']Username["']/i.test(html);
}

function looksLikeInvalidCreds(html: string): boolean {
  return (
    /invalid\s+(username|user\s*name|password|credentials)/i.test(html) ||
    /incorrect\s+(username|password)/i.test(html) ||
    /login\s+failed/i.test(html)
  );
}

/**
 * Log in to TrainingPeaks with username/password and return the
 * `Production_tpAuth` session cookie value. Throws `LoginError` on any
 * recognised failure mode (bad credentials, captcha enforcement, missing
 * session cookie, redirect loop).
 */
export async function loginForCookie(
  username: string,
  password: string,
): Promise<string> {
  if (!username || !password) {
    throw new LoginError("Username and password are required.");
  }

  const jar = new CookieJar();

  // ---- Step 1: GET the login page to seed cookies + grab the CSRF token --
  log.debug(`GET ${LOGIN_URL}`);
  const getRes = await fetch(LOGIN_URL, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!getRes.ok) {
    throw new LoginError(
      `Could not load login page: HTTP ${getRes.status} ${getRes.statusText}`,
    );
  }
  const finalGetUrl = new URL(getRes.url);
  jar.ingest(getSetCookieHeaders(getRes), finalGetUrl.hostname);
  const loginHtml = await getRes.text();
  const rvt = extractRequestVerificationToken(loginHtml);
  if (!rvt) {
    throw new LoginError(
      "Could not parse __RequestVerificationToken from login page (form changed?).",
    );
  }

  // ---- Step 2: POST credentials -----------------------------------------
  const formBody = new URLSearchParams();
  formBody.set("__RequestVerificationToken", rvt);
  formBody.set("Username", username);
  formBody.set("Password", password);
  formBody.set("CaptchaHidden", "true");
  formBody.set("CaptchaToken", "");
  formBody.set("Attempts", "");

  const postUrl = new URL(LOGIN_URL);
  log.debug(`POST ${LOGIN_URL}`);
  const postRes = await fetch(LOGIN_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/xhtml+xml",
      Cookie: jar.header(postUrl.hostname, postUrl.pathname),
      Referer: LOGIN_URL,
      Origin: "https://home.trainingpeaks.com",
    },
    body: formBody.toString(),
  });
  jar.ingest(getSetCookieHeaders(postRes), postUrl.hostname);
  log.debug(`POST -> ${postRes.status} ${postRes.statusText}`);

  // 200 with the login form re-rendered means creds were rejected (or
  // captcha enforcement kicked in).
  if (postRes.status === 200) {
    const body = await postRes.text();
    if (looksLikeInvalidCreds(body)) {
      throw new LoginError("Invalid username or password.");
    }
    if (looksLikeLoginForm(body)) {
      throw new LoginError(
        "Login form was re-rendered without a session cookie (captcha enforcement or unrecognised failure).",
      );
    }
    // 200 without redirect and without a recognised form — unexpected. Fall
    // through and check the cookie jar; the session may already be set.
  }

  // ---- Step 3: Follow redirects, persisting cookies ---------------------
  let nextLocation = postRes.headers.get("location");
  let prevHost = postUrl.hostname;
  if (nextLocation) {
    nextLocation = new URL(nextLocation, `https://${prevHost}`).toString();
  }

  for (let hop = 0; hop < MAX_REDIRECT_HOPS && nextLocation; hop++) {
    const u = new URL(nextLocation);
    log.debug(`GET ${nextLocation} (hop ${hop + 1})`);
    const res = await fetch(nextLocation, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        Cookie: jar.header(u.hostname, u.pathname),
        Referer: `https://${prevHost}/`,
      },
    });
    jar.ingest(getSetCookieHeaders(res), u.hostname);
    log.debug(`  -> ${res.status} ${res.statusText}`);

    const next = res.headers.get("location");
    prevHost = u.hostname;
    // Drain body to free the socket regardless of whether we follow further.
    await res.text().catch(() => "");
    if (!next) break;
    nextLocation = new URL(next, `https://${u.hostname}`).toString();
  }

  if (nextLocation && prevHost !== APP_HOST) {
    log.debug(`Redirect chain hit hop limit on ${prevHost}; checking cookie jar anyway.`);
  }

  // ---- Step 4: Verdict ---------------------------------------------------
  const cookie = jar.get(SESSION_COOKIE);
  if (!cookie) {
    throw new LoginError(
      `Login completed without a ${SESSION_COOKIE} cookie. Credentials may be wrong, or the server enforced captcha.`,
    );
  }
  return cookie;
}
