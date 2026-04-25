import { TPClient, NotFoundError, APIError } from "../client.js";
import { log } from "../util/log.js";
import type { TPAthleteSettings, TPMetricDay } from "./types.js";

/** Fetch the full athlete-settings blob (FTP, LTHR, zones, profile). */
export async function fetchAthleteSettings(
  client: TPClient,
  athleteId: number,
): Promise<TPAthleteSettings | null> {
  try {
    return await client.get<TPAthleteSettings>(`/fitness/v1/athletes/${athleteId}/settings`);
  } catch (err) {
    if (err instanceof NotFoundError) {
      log.warn(`Athlete settings endpoint returned 404 for athlete ${athleteId}.`);
      return null;
    }
    if (err instanceof APIError) {
      log.warn(`Athlete settings fetch failed (${err.status}); skipping.`);
      return null;
    }
    throw err;
  }
}

/**
 * Fetch consolidated daily metrics for [from, to] (ISO YYYY-MM-DD).
 * Returns [] on 404/empty.
 */
export async function fetchMetrics(
  client: TPClient,
  athleteId: number,
  from: string,
  to: string,
): Promise<TPMetricDay[]> {
  try {
    const data = await client.get<TPMetricDay[] | null>(
      `/metrics/v3/athletes/${athleteId}/consolidatedtimedmetrics/${from}/${to}`,
    );
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err instanceof NotFoundError) return [];
    if (err instanceof APIError) {
      log.warn(`Metrics fetch failed (${err.status}); continuing without.`);
      return [];
    }
    throw err;
  }
}

const METRIC_TYPE_WEIGHT = 9;

export interface LatestWeight {
  date: string; // YYYY-MM-DD
  kg: number;
  source?: string;
}

/**
 * Find the most recent body-weight entry. Probes the last `lookbackDays` window;
 * returns null if none found.
 */
export async function fetchLatestWeight(
  client: TPClient,
  athleteId: number,
  lookbackDays = 730,
  today: Date = new Date(),
): Promise<LatestWeight | null> {
  const to = today.toISOString().slice(0, 10);
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - lookbackDays);
  const from = fromDate.toISOString().slice(0, 10);

  const days = await fetchMetrics(client, athleteId, from, to);
  let latest: LatestWeight | null = null;
  for (const day of days) {
    const date = day.timeStamp?.slice(0, 10);
    if (!date) continue;
    for (const det of day.details ?? []) {
      if (det.type !== METRIC_TYPE_WEIGHT) continue;
      if (!Number.isFinite(det.value) || det.value <= 0) continue;
      if (!latest || date > latest.date) {
        latest = { date, kg: det.value, source: det.uploadClient ?? undefined };
      }
    }
  }
  return latest;
}
