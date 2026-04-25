import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { buildEnvConfig } from "../config.js";
import { log, setVerbose } from "../util/log.js";
import { ask, askSecret, confirm } from "../util/prompt.js";
import { ensureDir, exists, readIfExists } from "../io/fs.js";
import { updateEnvFile } from "../io/env.js";
import { AuthError, TokenManager } from "../auth.js";
import { TPClient } from "../client.js";
import { fetchUser, resolveAthleteId, resolveTimezone } from "../api/user.js";
import { LoginError, loginForCookie } from "../login.js";
import { runWithConfig } from "./pull.js";

const DEFAULT_WEEKS = 5;
const MAX_LOGIN_ATTEMPTS = 3;

function printHelp(): void {
  console.log(`tp init — scaffold a new workspace

A workspace is a directory holding one athlete's training data: .env with
credentials, hand-edited profile files, and the synced week files plus
generated derivatives. Every other tp command runs against the workspace
identified by the current working directory.

Usage:
  tp init                     scaffold a workspace in the current directory
  tp init my-log              create ./my-log/ and scaffold a workspace there
  tp init --weeks 12          pull 12 weeks after scaffolding (default ${DEFAULT_WEEKS})
  tp init --no-pull           scaffold only; skip the initial pull
  tp init --force             overwrite an existing .env
  tp init --username USER     pre-fill TrainingPeaks username (skips prompt)
  tp init --verbose

Steps performed:
  1. Resolve target workspace directory (created if missing).
  2. Prompt for TrainingPeaks username + password (or read from
     TP_USERNAME / TP_PASSWORD env vars), log in, and verify against
     the API. Username is cached in .env; password is not persisted.
  3. Write .env in the workspace.
  4. Run an initial pull (unless --no-pull).
`);
}

export async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      weeks: { type: "string" },
      "no-pull": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      username: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  setVerbose(Boolean(values.verbose));

  if (positionals.length > 1) {
    throw new Error(`tp init takes at most one positional argument (workspace directory).`);
  }

  let weeks = DEFAULT_WEEKS;
  if (values.weeks !== undefined) {
    const n = Number(values.weeks);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`--weeks must be a non-negative integer, got "${values.weeks}"`);
    }
    weeks = n;
  }
  const skipPull = Boolean(values["no-pull"]) || weeks === 0;
  const force = Boolean(values.force);

  // ---- Step 1: resolve workspace directory ------------------------------
  const targetDir = path.resolve(process.cwd(), positionals[0] ?? ".");
  const dirExists = await exists(targetDir);

  if (dirExists) {
    // Refuse if this looks like an existing workspace.
    const generatedDir = path.join(targetDir, "_generated");
    const athleteFile = path.join(targetDir, "ATHLETE.md");
    if ((await exists(generatedDir)) || (await exists(athleteFile))) {
      console.error(
        `\nRefusing to init: ${path.relative(process.cwd(), targetDir) || "."} already looks like a workspace.\n` +
          `Run \`tp pull\` from that directory to update it, or \`tp authenticate\` to refresh credentials.\n`,
      );
      process.exit(64);
    }

    const entries = await fs.readdir(targetDir);
    const visible = entries.filter((e) => !e.startsWith("."));
    if (visible.length > 0) {
      const ok = await confirm(
        `Directory ${targetDir} is not empty (${visible.length} visible entries). Continue?`,
        false,
      );
      if (!ok) {
        log.info("Aborted.");
        return;
      }
    }
  } else {
    await ensureDir(targetDir);
    log.info(`Created ${targetDir}`);
  }

  const envFile = path.join(targetDir, ".env");
  if ((await exists(envFile)) && !force) {
    const existing = (await readIfExists(envFile)) ?? "";
    if (/^\s*TP_COOKIE\s*=/m.test(existing)) {
      console.error(
        `\nRefusing to overwrite existing .env at ${envFile}.\n` +
          `Re-run with --force to replace it, edit it manually and run \`tp pull\`,\n` +
          `or run \`tp authenticate\` to refresh the cookie.\n`,
      );
      process.exit(64);
    }
  }

  // ---- Step 2: credentials prompt + login -------------------------------
  console.log("");
  console.log("Log in to TrainingPeaks.");
  console.log("(Credentials are sent only to home.trainingpeaks.com.)");
  console.log("");

  // Username: --flag > TP_USERNAME env > prompt.
  let username = (values.username ?? process.env.TP_USERNAME ?? "").trim();
  if (!username) {
    username = (await ask("Username")).trim();
    if (!username) {
      console.error("Username is required.");
      process.exit(64);
    }
  } else {
    log.info(`Using username: ${username}`);
  }

  // Password: TP_PASSWORD env > prompt.
  const envPassword = (process.env.TP_PASSWORD ?? "").trim();

  let cookie = "";
  let athleteId = 0;
  let timezone = "";
  let attempt = 0;
  while (attempt < MAX_LOGIN_ATTEMPTS) {
    attempt++;
    const password = envPassword || (await askSecret("Password"));
    if (!password) {
      console.error("  Empty password. Try again.\n");
      if (envPassword) {
        // env var is set but empty — bail rather than infinite-loop.
        process.exit(64);
      }
      continue;
    }

    log.info("Logging in…");
    try {
      const candidate = await loginForCookie(username, password);
      log.info("Verifying session…");
      const tokens = new TokenManager(candidate);
      const client = new TPClient(tokens);
      const user = await fetchUser(client);
      athleteId = resolveAthleteId(user, undefined);
      timezone = resolveTimezone(user);
      cookie = candidate;
      const name =
        [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || `athlete ${athleteId}`;
      log.info(`Authenticated as ${name} (id ${athleteId}, tz ${timezone}).`);
      break;
    } catch (err) {
      if (err instanceof LoginError || err instanceof AuthError) {
        const remaining = MAX_LOGIN_ATTEMPTS - attempt;
        if (remaining > 0 && !envPassword) {
          console.error(`  ${err.message} ${remaining} attempt(s) remaining.\n`);
          continue;
        }
        console.error(`\nLogin failed${envPassword ? "" : ` after ${MAX_LOGIN_ATTEMPTS} attempts`}: ${err.message}\n`);
        process.exit(2);
      }
      throw err;
    }
  }

  // ---- Step 3: write .env -----------------------------------------------
  await updateEnvFile(targetDir, {
    TP_USERNAME: username,
    TP_COOKIE: cookie,
    // TP_ATHLETE_ID stays unset by default — only coach accounts need it.
  });
  // Leave a templated comment block for first-time users.
  await stampInitialComments(envFile, athleteId);
  log.info(`Wrote ${path.relative(process.cwd(), envFile) || envFile}`);
  await tightenPermissions(envFile);

  // ---- Step 4: chained initial pull -------------------------------------
  if (skipPull) {
    console.log("");
    console.log("Workspace ready. Run `tp pull` from this directory when ready.");
    return;
  }

  console.log("");
  log.info(`Running initial pull (${weeks} week(s))...`);
  const env = buildEnvConfig({
    cookie,
    username,
    password: envPassword || undefined,
    projectRoot: targetDir,
  });
  await runWithConfig(env, { weeks, dryRun: false, athleteIdOverride: undefined });

  console.log("");
  const rel = path.relative(process.cwd(), targetDir);
  console.log(
    `Done. Browse ${rel === "" ? "this directory" : rel + "/"} ` +
      `and edit ATHLETE.md when you have time.`,
  );
}

/**
 * Add explanatory comments to a freshly-written `.env` file. Only does
 * anything if the file does not already contain comments — avoids clobbering
 * user-edited preambles on subsequent updates.
 */
async function stampInitialComments(envFile: string, athleteId: number): Promise<void> {
  const text = (await readIfExists(envFile)) ?? "";
  if (/^#/m.test(text)) return;
  const preamble =
    `# TrainingPeaks credentials.\n` +
    `# TP_COOKIE is auto-managed: refreshed automatically when expired,\n` +
    `# using TP_USERNAME (cached here) and your password (prompted, or read\n` +
    `# from the TP_PASSWORD env var). To rotate manually run \`tp authenticate\`.\n` +
    `#\n` +
    `# This file may contain a session cookie; treat it as a secret.\n` +
    `# Recommended: chmod 600 .env (POSIX).\n` +
    `#\n` +
    `# Optional: override the athlete id (coach accounts).\n` +
    `# TP_ATHLETE_ID=${athleteId}\n` +
    `\n`;
  const { writeAtomic } = await import("../io/fs.js");
  await writeAtomic(envFile, preamble + text);
}

/** Best-effort `chmod 600` on POSIX. No-op on Windows. */
async function tightenPermissions(envFile: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await fs.chmod(envFile, 0o600);
  } catch (err) {
    log.debug(`Could not chmod ${envFile}: ${(err as Error).message}`);
  }
}
