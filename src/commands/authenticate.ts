import { parseArgs } from "node:util";
import path from "node:path";
import { log, setVerbose } from "../util/log.js";
import { ask, askSecret } from "../util/prompt.js";
import { exists } from "../io/fs.js";
import { readEnvValues, updateEnvFile, envFilePath } from "../io/env.js";
import { AuthError, TokenManager } from "../auth.js";
import { TPClient } from "../client.js";
import { fetchUser, resolveAthleteId, resolveTimezone } from "../api/user.js";
import { LoginError, loginForCookie } from "../login.js";

const MAX_LOGIN_ATTEMPTS = 3;

function printHelp(): void {
  console.log(`tp authenticate — refresh the TrainingPeaks session cookie

Usage:
  tp authenticate                  prompt for password (uses cached username from .env)
  tp authenticate --username USER  override the cached username
  tp authenticate --verbose

Reads TP_USERNAME from .env (or --username flag) and prompts for the
password. Writes a fresh TP_COOKIE back to .env. Run from inside the
workspace (cwd must contain .env).
`);
}

export async function run(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      username: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }
  setVerbose(Boolean(values.verbose));

  const projectRoot = process.cwd();
  const envFile = envFilePath(projectRoot);
  if (!(await exists(envFile))) {
    console.error(
      `\nNo .env in ${projectRoot}.\nRun \`tp init\` to create a new workspace, or cd into an existing one.\n`,
    );
    process.exit(64);
  }

  // Resolve username: flag > env (TP_USERNAME from dotenv'd process.env) > .env file > prompt.
  // dotenv has already populated process.env via config.ts import chain, but
  // we don't want to require config.ts (which mandates TP_COOKIE). So read
  // .env directly here.
  const stored = (await readEnvValues(projectRoot, ["TP_USERNAME"])) ?? {};
  let username =
    (values.username ?? process.env.TP_USERNAME ?? stored.TP_USERNAME ?? "").trim();
  if (!username) {
    username = (await ask("Username")).trim();
    if (!username) {
      console.error("Username is required.");
      process.exit(64);
    }
  } else {
    log.info(`Using username: ${username}`);
  }

  let cookie = "";
  let attempt = 0;
  while (attempt < MAX_LOGIN_ATTEMPTS) {
    attempt++;
    const password = await askSecret("Password");
    if (!password) {
      console.error("  Empty password. Try again.\n");
      continue;
    }

    log.info("Logging in…");
    try {
      const candidate = await loginForCookie(username, password);
      log.info("Verifying session…");
      const tokens = new TokenManager(candidate);
      const client = new TPClient(tokens);
      const user = await fetchUser(client);
      const athleteId = resolveAthleteId(user, undefined);
      const timezone = resolveTimezone(user);
      cookie = candidate;
      const name =
        [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || `athlete ${athleteId}`;
      log.info(`Authenticated as ${name} (id ${athleteId}, tz ${timezone}).`);
      break;
    } catch (err) {
      if (err instanceof LoginError || err instanceof AuthError) {
        const remaining = MAX_LOGIN_ATTEMPTS - attempt;
        if (remaining > 0) {
          console.error(`  ${err.message} ${remaining} attempt(s) remaining.\n`);
          continue;
        }
        console.error(`\nLogin failed after ${MAX_LOGIN_ATTEMPTS} attempts: ${err.message}\n`);
        process.exit(2);
      }
      throw err;
    }
  }

  await updateEnvFile(projectRoot, {
    TP_USERNAME: username,
    TP_COOKIE: cookie,
  });
  log.info(`Updated ${path.relative(process.cwd(), envFile) || envFile}`);
}
