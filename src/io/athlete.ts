import path from "node:path";
import { readIfExists, writeAtomic, exists } from "../io/fs.js";
import { log } from "../util/log.js";

export interface AthleteProfile {
  ftp_watts: number | null;
  lthr_bpm: number | null;
  max_hr: number | null;
  threshold_pace_run_s_per_km: number | null;
  swim_css_s_per_100m: number | null;
  weight_kg: number | null;
  current_block: string | null;
  phase_start: string | null;
  goals: Array<{ date: string; name: string; priority?: string }>;
  /** Raw frontmatter as last read, for round-trip logging. */
  raw: Record<string, unknown>;
}

const TEMPLATE = `---
# Hand-edited athlete profile. Never overwritten by \`tp pull\`.
# Physiology (FTP, LTHR, max HR, weight, zones) is auto-synced into
# \`_generated/athlete.tp.md\` from TrainingPeaks. Keep _that_ file as source of truth.
# Use this file for things TrainingPeaks doesn't know:
#   - what training block you're in and when it started
#   - hand-curated A-races / goals not yet entered in TP
#   - free-form notes (constraints, injuries, equipment, coach context)

current_block: null
phase_start: null          # YYYY-MM-DD, when current_block started

goals: []
# goals:
#   - { date: 2026-06-14, name: "70.3 Zell am See", priority: A }
---

# Athlete profile

Hand-edited notes about your current block, A-races, constraints, and anything
else an LLM should know before suggesting plan changes. Free-form below.

> Physiology values (FTP, LTHR, zones, weight) live in \`_generated/athlete.tp.md\` —
> regenerated each \`tp pull\` from TrainingPeaks. Edit them in TP, not here.
`;

export const ATHLETE_FILENAME = "ATHLETE.md";

export async function ensureAthleteFile(outDir: string): Promise<string> {
  const p = path.join(outDir, ATHLETE_FILENAME);
  if (!(await exists(p))) {
    await writeAtomic(p, TEMPLATE);
    log.info(`Created ${path.relative(outDir, p)} — edit it to set current_block and goals.`);
  }
  return p;
}

/**
 * Minimal YAML-frontmatter parser. We only parse the simple types we write
 * into the template (scalars, null, string, number, inline arrays via JSON
 * syntax, simple lists). No dependency on a full YAML library.
 */
export async function readAthleteProfile(outDir: string): Promise<AthleteProfile | null> {
  const p = path.join(outDir, ATHLETE_FILENAME);
  const text = await readIfExists(p);
  if (!text) return null;

  const fmMatch = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(text);
  if (!fmMatch) return null;

  const body = fmMatch[1];
  const raw = parseSimpleYaml(body);

  const prof: AthleteProfile = {
    ftp_watts: numOrNull(raw.ftp_watts),
    lthr_bpm: numOrNull(raw.lthr_bpm),
    max_hr: numOrNull(raw.max_hr),
    threshold_pace_run_s_per_km: numOrNull(raw.threshold_pace_run_s_per_km),
    swim_css_s_per_100m: numOrNull(raw.swim_css_s_per_100m),
    weight_kg: numOrNull(raw.weight_kg),
    current_block: strOrNull(raw.current_block),
    phase_start: strOrNull(raw.phase_start),
    goals: Array.isArray(raw.goals)
      ? (raw.goals as unknown[]).map((g) => g as { date: string; name: string; priority?: string })
      : [],
    raw,
  };
  return prof;
}

/** Warn if phase_start is >90 days old. Physiology lives in `_generated/athlete.tp.md`. */
export function warnIfStale(p: AthleteProfile, today = new Date()): void {
  if (p.phase_start) {
    const d = new Date(p.phase_start);
    if (!Number.isNaN(d.getTime())) {
      const days = (today.getTime() - d.getTime()) / 86400000;
      if (days > 90) {
        log.warn(
          `${ATHLETE_FILENAME}: phase_start is ${Math.round(days)} days old — update current_block/phase_start?`,
        );
      }
    }
  }
}

// ---------- tiny YAML subset parser ----------

function parseSimpleYaml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const rest = stripComment(m[2]).trim();
    if (rest === "" || rest === "null") {
      // Could be: (a) null scalar, or (b) a block-style list/map starting on next line.
      // Look ahead at next non-blank line indent.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && /^\s{2,}-\s/.test(lines[j])) {
        // block list
        const items: unknown[] = [];
        while (j < lines.length && /^\s{2,}-\s/.test(lines[j])) {
          const li = lines[j].replace(/^\s{2,}-\s/, "").trim();
          items.push(parseScalar(li));
          j++;
        }
        out[key] = items;
        i = j;
        continue;
      }
      if (j < lines.length && /^\s{2,}[A-Za-z_]/.test(lines[j])) {
        // block map — read indent 2+
        const sub: Record<string, unknown> = {};
        while (j < lines.length && /^\s{2,}[A-Za-z_]/.test(lines[j])) {
          const mm = /^\s{2,}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(lines[j]);
          if (mm) sub[mm[1]] = parseScalar(stripComment(mm[2]).trim());
          j++;
        }
        out[key] = sub;
        i = j;
        continue;
      }
      out[key] = rest === "null" ? null : null;
      i++;
      continue;
    }
    out[key] = parseScalar(rest);
    i++;
  }
  return out;
}

function stripComment(s: string): string {
  // Naive: strip " # ..." (must be preceded by space to avoid URL fragments etc.)
  const idx = s.search(/\s#/);
  return idx >= 0 ? s.slice(0, idx) : s;
}

function parseScalar(s: string): unknown {
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  const n = Number(s);
  if (!Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(s)) return n;
  // strip quotes if present
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
