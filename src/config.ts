import "dotenv/config";

export interface EnvConfig {
  cookie: string;
  /** Optional cached username for re-authentication. */
  username: string | undefined;
  /** Optional password (env-only by default; not persisted to disk by `tp init`). */
  password: string | undefined;
  athleteIdOverride: number | undefined;
  outDir: string;
  projectRoot: string;
}

/**
 * Read environment-level configuration from `process.env` (populated by
 * `dotenv` at module import time). Used by command entry points that take
 * their config from the user's shell.
 */
export function loadEnvFromProcess(): EnvConfig {
  const cookie = (process.env.TP_COOKIE ?? "").trim();
  if (!cookie) {
    throw new Error(
      "Missing TP_COOKIE. Run `tp init` to create a workspace, or `tp authenticate` from inside an existing one to refresh the cookie.",
    );
  }

  const envAthlete = (process.env.TP_ATHLETE_ID ?? "").trim();
  const athleteIdOverride = envAthlete ? Number(envAthlete) : undefined;
  if (athleteIdOverride !== undefined && !Number.isFinite(athleteIdOverride)) {
    throw new Error("TP_ATHLETE_ID must be a number");
  }

  const username = (process.env.TP_USERNAME ?? "").trim() || undefined;
  const password = (process.env.TP_PASSWORD ?? "").trim() || undefined;

  return buildEnvConfig({
    cookie,
    username,
    password,
    projectRoot: process.cwd(),
    athleteIdOverride,
  });
}

/**
 * Backwards-compatible alias for the legacy import name.
 * @deprecated use `loadEnvFromProcess`
 */
export const loadEnvConfig = loadEnvFromProcess;

/**
 * Construct an `EnvConfig` from explicit inputs. Used by `tp init` so it can
 * target a freshly-created workspace directory without mutating `process.env`
 * or relying on dotenv being loaded from the right cwd.
 */
export function buildEnvConfig(params: {
  cookie: string;
  projectRoot: string;
  username?: string | undefined;
  password?: string | undefined;
  athleteIdOverride?: number | undefined;
}): EnvConfig {
  if (!params.cookie || params.cookie.trim() === "") {
    throw new Error("buildEnvConfig: cookie is required");
  }
  return {
    cookie: params.cookie.trim(),
    username: params.username?.trim() || undefined,
    password: params.password?.trim() || undefined,
    athleteIdOverride: params.athleteIdOverride,
    // outDir is the workspace root itself — generated files live alongside .env
    // so the directory IS the workspace (no nested out/ layer).
    outDir: params.projectRoot,
    projectRoot: params.projectRoot,
  };
}

/**
 * Resolve athlete override after combining env + CLI flag (CLI wins).
 */
export function resolveAthleteOverride(
  env: EnvConfig,
  flag: string | undefined,
): number | undefined {
  if (flag === undefined) return env.athleteIdOverride;
  const n = Number(flag);
  if (!Number.isFinite(n)) {
    throw new Error(`--athlete must be a number, got "${flag}"`);
  }
  return n;
}
