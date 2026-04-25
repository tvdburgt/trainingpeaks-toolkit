import path from "node:path";
import { readIfExists, writeAtomic } from "./fs.js";

/**
 * Tiny `.env` reader/writer for the toolkit's own state. We don't need full
 * dotenv parser semantics here — just safe upsert of a handful of keys
 * (`TP_COOKIE`, `TP_USERNAME`, `TP_ATHLETE_ID`) used by `tp init` /
 * `tp authenticate` and the auto-refresh persistence hook.
 *
 * Limitations (intentional, document if extended):
 *   - No quote handling. Values are written and read raw.
 *   - Comment lines and blank lines are preserved on update.
 *   - If a key appears multiple times, only the first occurrence is updated;
 *     later duplicates are left untouched (`dotenv` reads the first anyway).
 */

export type EnvUpdates = Record<string, string | undefined>;

const KEY_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function envFilePath(projectRoot: string): string {
  return path.join(projectRoot, ".env");
}

/** Parse an `.env` file's text. Returns key→value (first occurrence wins). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(KEY_LINE);
    if (!m) continue;
    if (m[1] in out) continue;
    out[m[1]] = m[2];
  }
  return out;
}

/**
 * Read `.env` and return the values for the requested keys. Missing keys
 * map to `undefined`. Returns `undefined` for the whole result if the file
 * is missing.
 */
export async function readEnvValues(
  projectRoot: string,
  keys: string[],
): Promise<Record<string, string | undefined> | undefined> {
  const text = await readIfExists(envFilePath(projectRoot));
  if (text === undefined) return undefined;
  const parsed = parseEnv(text);
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = parsed[k];
  return out;
}

/**
 * Update keys in `.env` in place. Existing keys are rewritten on their
 * existing line; new keys are appended. Keys with `undefined` values are
 * removed. Preserves comments and other lines verbatim.
 *
 * If the file does not exist, it is created with just the supplied keys.
 */
export async function updateEnvFile(
  projectRoot: string,
  updates: EnvUpdates,
): Promise<string> {
  const file = envFilePath(projectRoot);
  const existing = (await readIfExists(file)) ?? "";

  const lines = existing.length === 0 ? [] : existing.split(/\r?\n/);
  const seen = new Set<string>();
  const remaining = new Set(Object.keys(updates));

  // Pass 1: rewrite existing lines.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(KEY_LINE);
    if (!m) continue;
    const key = m[1];
    if (seen.has(key)) continue; // keep duplicates untouched
    seen.add(key);
    if (!(key in updates)) continue;
    const value = updates[key];
    if (value === undefined) {
      // Mark for removal — replace with sentinel and filter out at end.
      lines[i] = "\u0000__DELETE__\u0000";
    } else {
      lines[i] = `${key}=${value}`;
    }
    remaining.delete(key);
  }

  // Pass 2: append any new keys.
  if (remaining.size > 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    for (const key of remaining) {
      const value = updates[key];
      if (value === undefined) continue;
      lines.push(`${key}=${value}`);
    }
  }

  const content = lines
    .filter((l) => l !== "\u0000__DELETE__\u0000")
    .join("\n")
    .replace(/\n+$/, "")
    .concat("\n");

  await writeAtomic(file, content);
  return file;
}
