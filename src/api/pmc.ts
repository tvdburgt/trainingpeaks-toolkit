import { TPClient, APIError, NotFoundError } from "../client.js";
import { log } from "../util/log.js";
import type {
  TPPerformanceDataPoint,
  TPPerformanceDataRequest,
} from "./types.js";

function fmtDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Fetch the Performance Management Chart (CTL/ATL/TSB) daily series for
 * an athlete between start and end (inclusive).
 *
 * Endpoint: POST /fitness/v1/athletes/{id}/reporting/performancedata/{start}/{end}
 *
 * Returns one row per calendar day in the range. The spike confirmed that
 * TP warm-starts CTL/ATL from the athlete's historical data, not from
 * ctlStart/atlStart (which only take effect if no prior history exists).
 * So requesting the analysis window directly gives correct, converged values.
 */
export async function listPerformanceData(
  client: TPClient,
  athleteId: number,
  start: Date,
  end: Date,
  opts: Partial<TPPerformanceDataRequest> = {},
): Promise<TPPerformanceDataPoint[]> {
  const body: TPPerformanceDataRequest = {
    atlConstant: opts.atlConstant ?? 7,
    atlStart: opts.atlStart ?? 0,
    ctlConstant: opts.ctlConstant ?? 42,
    ctlStart: opts.ctlStart ?? 0,
    workoutTypes: opts.workoutTypes ?? [],
  };

  const path = `/fitness/v1/athletes/${athleteId}/reporting/performancedata/${fmtDate(start)}/${fmtDate(end)}`;
  log.debug(`POST ${path}`);

  try {
    const res = await client.post<TPPerformanceDataPoint[] | { data?: TPPerformanceDataPoint[] }>(
      path,
      body,
    );
    if (Array.isArray(res)) return res;
    if (res && Array.isArray((res as { data?: unknown }).data)) {
      return (res as { data: TPPerformanceDataPoint[] }).data;
    }
    return [];
  } catch (err) {
    if (err instanceof NotFoundError) {
      log.debug(`No PMC data in range ${fmtDate(start)} .. ${fmtDate(end)}`);
      return [];
    }
    if (err instanceof APIError && err.status === 400) {
      log.warn(`PMC endpoint returned 400: ${err.body?.slice(0, 300) ?? ""}`);
      return [];
    }
    throw err;
  }
}
