import { parseArgs } from "node:util";
import path from "node:path";
import {
  loadEnvFromProcess,
  resolveAthleteOverride,
  TP_DIR,
  type EnvConfig,
} from "../config.js";
import { log, setVerbose } from "../util/log.js";
import { buildTokenManager } from "../bootstrap.js";
import { TPClient } from "../client.js";
import { fetchUser, resolveAthleteId, resolveTimezone } from "../api/user.js";
import { fetchAthleteSettings, fetchLatestWeight } from "../api/athlete.js";
import { listWorkouts, getWorkoutLaps } from "../api/workouts.js";
import { listEvents } from "../api/events.js";
import { listPerformanceData } from "../api/pmc.js";
import { transformWorkout, transformEvent } from "../transform/workout.js";
import { groupByWeek, type WeekBucket } from "../transform/week.js";
import { indexLoad, computeWeekLoad } from "../transform/load.js";
import { renderWeek } from "../render/markdown.js";
import { emitWorkoutsJsonl } from "../render/jsonl.js";
import { emitLoadJsonl } from "../render/load.js";
import { writeSchemaFile } from "../render/schema.js";
import { writeIndex } from "../render/index.js";
import { ensureAthleteFile, readAthleteProfile, warnIfStale } from "../io/athlete.js";
import { writeAthleteTpFile } from "../io/athleteTp.js";
import { writeEventsFile } from "../io/events.js";
import { writeAtomic, exists } from "../io/fs.js";
import { isoWeekOf, isoWeekBounds } from "../util/isoWeek.js";

const DEFAULT_WEEKS = 52; // ~1 year

function printHelp(): void {
  console.log(`tp pull — sync TrainingPeaks into the current workspace

Run from inside a workspace (cwd must contain .env, created by \`tp init\`).
Writes weekly markdown files alongside .env, one per ISO week.

Usage:
  tp pull                     pull last ${DEFAULT_WEEKS} ISO weeks (~1 year)
  tp pull --weeks 104         pull last 104 weeks (~2 years)
  tp pull --dry-run           fetch + render without writing
  tp pull --athlete 1234567   target a specific athlete id
  tp pull --verbose

Incremental behaviour:
  - The current ISO week is always re-pulled.
  - Older weeks are only pulled when the corresponding <year>/<NN>.md file
    is missing from the workspace. Delete a file to regenerate that week.
  - Weeks are processed newest-first so interrupting keeps the latest data.
`);
}

/** Options that control a pull. Shared by `run` and `runWithConfig`. */
export interface PullOptions {
  /** Number of ISO weeks to consider, newest-first. */
  weeks: number;
  /** Render and report without touching disk. */
  dryRun: boolean;
  /** Optional athlete-id override (used by coach accounts). */
  athleteIdOverride?: number | undefined;
}

export async function run(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      weeks: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      athlete: { type: "string" },
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

  let weeks = DEFAULT_WEEKS;
  if (values.weeks !== undefined) {
    const n = Number(values.weeks);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--weeks must be a positive integer, got "${values.weeks}"`);
    }
    weeks = n;
  }

  const env = loadEnvFromProcess();
  const athleteIdOverride = resolveAthleteOverride(env, values.athlete);
  setVerbose(Boolean(values.verbose));

  await runWithConfig(env, {
    weeks,
    dryRun: Boolean(values["dry-run"]),
    athleteIdOverride,
  });
}

/**
 * Core pull orchestration. Takes an explicit `EnvConfig` so callers like
 * `tp init` can target a freshly-created workspace without going
 * through `process.env`.
 */
export async function runWithConfig(env: EnvConfig, opts: PullOptions): Promise<void> {
  const { weeks, dryRun, athleteIdOverride } = opts;

  const tokens = buildTokenManager(env);
  const client = new TPClient(tokens);

  log.info("Fetching user profile...");
  const user = await fetchUser(client);
  const athleteId = resolveAthleteId(user, athleteIdOverride);
  const timezone = resolveTimezone(user);
  log.info(`Athlete id: ${athleteId}, timezone: ${timezone}`);

  // Hand-edited profile: scaffold on first run, read & warn if stale.
  if (!dryRun) await ensureAthleteFile(env.outDir);
  const profile = await readAthleteProfile(env.outDir);
  if (profile) warnIfStale(profile);

  // Auto-synced TP profile mirror (`.tp/athlete.tp.md`). Regenerated every pull.
  if (!dryRun) {
    log.info("Syncing athlete settings from TrainingPeaks...");
    const [settings, latestWeight] = await Promise.all([
      fetchAthleteSettings(client, athleteId),
      fetchLatestWeight(client, athleteId),
    ]);
    const tpFile = await writeAthleteTpFile(env.outDir, {
      athleteId,
      generatedAt: new Date(),
      settings,
      latestWeight,
    });
    const ftp = settings?.powerZones?.[0]?.threshold;
    const lthr = settings?.heartRateZones?.[0]?.threshold;
    log.info(
      `Wrote ${path.relative(env.projectRoot, tpFile)} ` +
        `(FTP: ${ftp ?? "n/a"}W, LTHR: ${lthr ?? "n/a"}, ` +
        `weight: ${latestWeight ? `${latestWeight.kg}kg @ ${latestWeight.date}` : "n/a"})`,
    );
  }

  const currentWeek = isoWeekOf(new Date(), timezone);
  const candidates = listLastNWeeks(currentWeek.isoYear, currentWeek.isoWeek, weeks);
  log.info(
    `Considering ${candidates.length} weeks: ${candidates[0].key} (current) .. ${candidates[candidates.length - 1].key}`,
  );

  const currentKey = currentWeek.key;
  const toPull: typeof candidates = [];
  for (const c of candidates) {
    const filePath = weekFilePath(env.outDir, c.isoYear, c.isoWeek);
    const fileExists = await exists(filePath);
    if (c.key === currentKey || !fileExists) toPull.push(c);
  }

  // Note: toPull always contains the current week (see loop above), so we
  // always fetch at least one week's worth of workouts. PMC runs on the full
  // analysis window regardless.
  log.info(`Pulling ${toPull.length} week(s), newest first.`);

  const range = rangeForWeeks(toPull, timezone);
  log.info(
    `Range: ${range.from.toISOString().slice(0, 10)} .. ${range.to.toISOString().slice(0, 10)}`,
  );

  log.info("Fetching workouts...");
  const rawWorkouts = await listWorkouts(client, athleteId, range.from, range.to);
  log.info(`Fetched ${rawWorkouts.length} workouts`);

  // Events span past + future: same lower bound as workouts, but extend 12 months
  // ahead so upcoming races appear in `.tp/events.md` and `.tp/index.md`.
  const eventsRange = {
    from: range.from,
    to: addMonthsUtc(new Date(), 12),
  };
  log.info(
    `Events range: ${eventsRange.from.toISOString().slice(0, 10)} .. ${eventsRange.to.toISOString().slice(0, 10)}`,
  );
  log.info("Fetching events...");
  const rawEvents = await listEvents(client, athleteId, eventsRange.from, eventsRange.to);
  log.info(`Fetched ${rawEvents.length} events`);

  // PMC covers the full analysis window (not just toPull) so every week we
  // render has correct CTL/ATL/TSB, and the full load.jsonl is always fresh.
  const pmcRange = rangeForWeeks(candidates, timezone);
  log.info(
    `Fetching PMC ${pmcRange.from.toISOString().slice(0, 10)} .. ${pmcRange.to.toISOString().slice(0, 10)}`,
  );
  const pmcPoints = await listPerformanceData(client, athleteId, pmcRange.from, pmcRange.to);
  log.info(`Fetched ${pmcPoints.length} PMC daily points`);
  const loadIndex = indexLoad(pmcPoints);

  const workouts = rawWorkouts.map((raw) => transformWorkout(raw, undefined, timezone));
  const events = rawEvents.map((e) => transformEvent(e, timezone));
  const weekMap = groupByWeek(workouts, timezone);

  const generatedAt = new Date();
  const currentKeyForPhase = currentWeek.key;
  let written = 0;

  for (let i = 0; i < toPull.length; i++) {
    const target = toPull[i];
    const bucket: WeekBucket = weekMap.get(target.key) ?? {
      isoYear: target.isoYear,
      isoWeek: target.isoWeek,
      key: target.key,
      workouts: [],
    };

    for (const w of bucket.workouts) {
      if (!w.completed) continue;
      const hasDeviceData =
        w.actual.powerAvg !== undefined ||
        w.actual.hrAvg !== undefined ||
        w.actual.speedAvgMps !== undefined;
      if (!hasDeviceData) continue;
      try {
        const rawLaps = await getWorkoutLaps(client, athleteId, w.id);
        if (rawLaps.length > 0) {
          const fromRaw = rawWorkouts.find((r) => r.workoutId === w.id);
          if (fromRaw) {
            const rebuilt = transformWorkout(fromRaw, rawLaps, timezone);
            const idx = bucket.workouts.findIndex((x) => x.id === w.id);
            if (idx >= 0) bucket.workouts[idx] = rebuilt;
          }
        }
      } catch (err) {
        log.debug(`Skipping laps for ${w.id}: ${(err as Error).message}`);
      }
    }

    const weekLoad = computeWeekLoad(bucket.isoYear, bucket.isoWeek, timezone, loadIndex);
    const phase: "past" | "current" | "future" =
      bucket.key === currentKeyForPhase
        ? "current"
        : bucket.key > currentKeyForPhase
          ? "future"
          : "past";

    const md = renderWeek(bucket, {
      athleteId,
      timezone,
      generatedAt,
      load: weekLoad,
      phase,
    });
    const filePath = weekFilePath(env.outDir, bucket.isoYear, bucket.isoWeek);

    if (!dryRun) {
      await writeAtomic(filePath, md);
    }
    written++;
    log.info(
      `[${i + 1}/${toPull.length}] ${dryRun ? "[dry-run]" : "Wrote"} ${path.relative(env.projectRoot, filePath)} (${bucket.workouts.length} workouts)`,
    );
  }

  log.info(`Done. ${written} week file(s) ${dryRun ? "would be written" : "written"}.`);

  // Emit machine-readable datasets + synced meta files under <workspace>/.tp/.
  if (!dryRun) {
    const generatedDir = path.join(env.outDir, TP_DIR);

    const { workoutsFile, lapsWritten, structureWritten } = await emitWorkoutsJsonl(
      [...weekMap.values()].flatMap((b) => b.workouts),
      { athleteId, timezone, generatedAt, generatedDir },
    );
    log.info(
      `Wrote ${path.relative(env.projectRoot, workoutsFile)} (${lapsWritten} laps, ${structureWritten} structure sidecars)`,
    );

    const { file: loadFile, rows, records: loadRecords } = await emitLoadJsonl(
      pmcPoints,
      generatedDir,
    );
    log.info(`Wrote ${path.relative(env.projectRoot, loadFile)} (${rows} days)`);

    // Static schema reference — rewritten every pull so toolkit upgrades
    // always reflect the current data shape.
    const schemaFile = await writeSchemaFile(env.outDir);
    log.debug(`Schema file: ${path.relative(env.projectRoot, schemaFile)}`);

    const indexFile = await writeIndex({
      athleteId,
      timezone,
      generatedAt,
      outDir: env.outDir,
      load: loadRecords,
      events,
      profile,
    });
    log.info(`Wrote ${path.relative(env.projectRoot, indexFile)}`);

    const eventsFile = await writeEventsFile(env.outDir, {
      athleteId,
      generatedAt,
      timezone,
      range: eventsRange,
      events,
    });
    const upcoming = events.filter((e) => e.date >= todayYmd(generatedAt, timezone)).length;
    const past = events.length - upcoming;
    log.info(
      `Wrote ${path.relative(env.projectRoot, eventsFile)} (${upcoming} upcoming, ${past} past)`,
    );
  }
}

function todayYmd(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addMonthsUtc(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + months);
  return r;
}

function weekFilePath(outDir: string, isoYear: number, isoWeek: number): string {
  return path.join(outDir, String(isoYear), `${String(isoWeek).padStart(2, "0")}.md`);
}

/**
 * Return the last `count` ISO weeks ending at (isoYear, isoWeek) inclusive, newest first.
 */
function listLastNWeeks(
  isoYear: number,
  isoWeek: number,
  count: number,
): Array<{ isoYear: number; isoWeek: number; key: string }> {
  const out: Array<{ isoYear: number; isoWeek: number; key: string }> = [];
  let y = isoYear;
  let w = isoWeek;
  for (let i = 0; i < count; i++) {
    out.push({
      isoYear: y,
      isoWeek: w,
      key: `${y}-W${String(w).padStart(2, "0")}`,
    });
    w--;
    if (w < 1) {
      y--;
      w = isoWeeksInYear(y);
    }
  }
  return out;
}

/** Number of ISO weeks in a given ISO week-year (52 or 53). */
function isoWeeksInYear(isoYear: number): number {
  const jan1 = new Date(Date.UTC(isoYear, 0, 1)).getUTCDay();
  const dec31 = new Date(Date.UTC(isoYear, 11, 31)).getUTCDay();
  return jan1 === 4 || dec31 === 4 ? 53 : 52;
}

/** Inclusive UTC range covering all target weeks, for chunked list fetches. */
function rangeForWeeks(
  targets: Array<{ isoYear: number; isoWeek: number }>,
  timezone: string,
): { from: Date; to: Date } {
  let from: Date | undefined;
  let to: Date | undefined;
  for (const t of targets) {
    const { start, end } = isoWeekBounds(t.isoYear, t.isoWeek, timezone);
    if (!from || start < from) from = start;
    if (!to || end > to) to = end;
  }
  return { from: from!, to: to! };
}
