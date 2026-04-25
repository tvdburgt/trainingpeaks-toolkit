import { TPClient, NotFoundError } from "../client.js";
import { log } from "../util/log.js";
import type { TPEvent } from "./types.js";

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

/**
 * List events/races in a date range. Chunked to 180 days.
 * Endpoint: /fitness/v1/athletes/{id}/events/{start}/{end}
 * (Fallback: /fitness/v2/athletes/{id}/events/... — we try v1 first and silently
 * continue on 404. Events are optional enrichment.)
 */
export async function listEvents(
  client: TPClient,
  athleteId: number,
  start: Date,
  end: Date,
): Promise<TPEvent[]> {
  const out: TPEvent[] = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));

  while (cursor <= last) {
    const chunkEnd = addDays(cursor, 180);
    const effEnd = chunkEnd > last ? last : chunkEnd;

    const tried: string[] = [
      `/fitness/v1/athletes/${athleteId}/events/${fmtDate(cursor)}/${fmtDate(effEnd)}`,
      `/fitness/v2/athletes/${athleteId}/events/${fmtDate(cursor)}/${fmtDate(effEnd)}`,
    ];

    let chunk: TPEvent[] | undefined;
    for (const path of tried) {
      try {
        chunk = await client.get<TPEvent[]>(path);
        if (Array.isArray(chunk)) break;
      } catch (err) {
        if (err instanceof NotFoundError) continue;
        log.debug(`Events fetch error (${path}): ${(err as Error).message}`);
      }
    }
    if (Array.isArray(chunk)) out.push(...chunk);

    cursor = addDays(effEnd, 1);
  }

  return out;
}
