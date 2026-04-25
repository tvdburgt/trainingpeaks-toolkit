import { TPClient, APIError, NotFoundError } from "../client.js";
import { log } from "../util/log.js";
import type {
  TPWorkoutListItem,
  TPDetailDataResponse,
  TPRawLapStat,
  TPLap,
} from "./types.js";

const MAX_RANGE_DAYS = 45; // TP accepts up to 90; keep chunks smaller to be safe.

function fmtDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * List workouts for an athlete between start and end (inclusive). Handles chunking.
 * Endpoint: /fitness/v6/athletes/{id}/workouts/{start}/{end} (verified live).
 */
export async function listWorkouts(
  client: TPClient,
  athleteId: number,
  start: Date,
  end: Date,
): Promise<TPWorkoutListItem[]> {
  const out: TPWorkoutListItem[] = [];
  let cursor = startOfDayUTC(start);
  const last = startOfDayUTC(end);

  while (cursor <= last) {
    const chunkEnd = addDays(cursor, MAX_RANGE_DAYS - 1);
    const effEnd = chunkEnd > last ? last : chunkEnd;
    const path = `/fitness/v6/athletes/${athleteId}/workouts/${fmtDate(cursor)}/${fmtDate(effEnd)}`;
    log.debug(`Fetching workouts ${fmtDate(cursor)} .. ${fmtDate(effEnd)}`);
    try {
      const chunk = await client.get<TPWorkoutListItem[]>(path);
      if (Array.isArray(chunk)) out.push(...chunk);
    } catch (err) {
      if (err instanceof NotFoundError) {
        log.debug(`No workouts in range ${fmtDate(cursor)} .. ${fmtDate(effEnd)}`);
      } else {
        throw err;
      }
    }
    cursor = addDays(effEnd, 1);
  }

  return out;
}

/**
 * Fetch full workout detail (single workout). The list endpoint already returns
 * description + structure + stats, so this is only used as a fallback.
 * Endpoint: /fitness/v6/athletes/{id}/workouts/{wid} (verified live).
 */
export async function getWorkoutDetail(
  client: TPClient,
  athleteId: number,
  workoutId: number,
): Promise<TPWorkoutListItem | undefined> {
  try {
    return await client.get<TPWorkoutListItem>(
      `/fitness/v6/athletes/${athleteId}/workouts/${workoutId}`,
    );
  } catch (err) {
    if (err instanceof NotFoundError) return undefined;
    throw err;
  }
}

/**
 * Fetch lap splits for a workout.
 * Endpoint: /fitness/v6/athletes/{id}/workouts/{wid}/detaildata -> lapsStats[].
 * Raw lap times are milliseconds; we normalise to seconds here.
 */
export async function getWorkoutLaps(
  client: TPClient,
  athleteId: number,
  workoutId: number,
): Promise<TPLap[]> {
  try {
    const res = await client.get<TPDetailDataResponse>(
      `/fitness/v6/athletes/${athleteId}/workouts/${workoutId}/detaildata`,
    );
    const raw = res?.lapsStats ?? [];
    return raw.map((lap, idx) => normaliseLap(lap, idx));
  } catch (err) {
    if (err instanceof NotFoundError) return [];
    // 400 means TP has no device samples for this workout (e.g. manually logged).
    if (err instanceof APIError && err.status === 400) return [];
    log.debug(`Lap fetch failed for ${workoutId}: ${(err as Error).message}`);
    return [];
  }
}

function msToSec(v: number | null | undefined): number {
  if (v == null) return 0;
  return Math.round(v / 100) / 10; // 1 decimal, seconds
}

function normaliseLap(raw: TPRawLapStat, idx: number): TPLap {
  return {
    lapNumber: idx + 1,
    name: raw.name ?? null,
    beginOffsetSec: msToSec(raw.begin),
    elapsedSec: msToSec(raw.elapsedTime),
    stoppedSec: msToSec(raw.stoppedTime),
    distanceMeters: raw.distance ?? null,
    heartRateAverage: raw.averageHeartRate ?? null,
    heartRateMaximum: raw.maximumHeartRate ?? null,
    powerAverage: raw.averagePower ?? null,
    powerMaximum: raw.maximumPower ?? null,
    normalizedPower: raw.normalizedPowerActual ?? null,
    cadenceAverage: raw.averageCadence ?? null,
    cadenceMaximum: raw.maximumCadence ?? null,
    speedAverage: raw.averageSpeed ?? null,
    speedMaximum: raw.maximumSpeed ?? null,
    elevationGain: raw.elevationGain ?? null,
    elevationLoss: raw.elevationLoss ?? null,
    tssActual: raw.trainingStressScoreActual ?? null,
    intensityFactor: raw.intensityFactorActual ?? null,
    calories: raw.calories ?? null,
    energy: raw.energy ?? null,
  };
}
