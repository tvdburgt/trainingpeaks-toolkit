import path from "node:path";
import type { TPPerformanceDataPoint } from "../api/types.js";
import { writeAtomic, ensureDir } from "../io/fs.js";

export interface LoadRecord {
  date: string; // YYYY-MM-DD
  tss_actual: number | null;
  tss_planned: number | null;
  if_actual: number | null;
  if_planned: number | null;
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
}

function round1(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 10) / 10;
}

function round2(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

export function pmcPointToRecord(p: TPPerformanceDataPoint): LoadRecord {
  const date = (p.workoutDay ?? "").split("T")[0];
  return {
    date,
    tss_actual: round1(p.tssActual ?? null),
    tss_planned: round1(p.tssPlanned ?? null),
    if_actual: round2(p.ifActual ?? null),
    if_planned: round2(p.ifPlanned ?? null),
    ctl: round1(p.ctl ?? null),
    atl: round1(p.atl ?? null),
    tsb: round1(p.tsb ?? null),
  };
}

/**
 * Emit load.jsonl to <workspace>/.tp/. Full rewrite per run.
 * One line per calendar day in the requested PMC window.
 */
export async function emitLoadJsonl(
  points: TPPerformanceDataPoint[],
  generatedDir: string,
): Promise<{ file: string; rows: number; records: LoadRecord[] }> {
  await ensureDir(generatedDir);

  const sorted = [...points]
    .map(pmcPointToRecord)
    .filter((r) => r.date.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const file = path.join(generatedDir, "load.jsonl");
  const body = sorted.map((r) => JSON.stringify(r)).join("\n") + (sorted.length ? "\n" : "");
  await writeAtomic(file, body);

  return { file, rows: sorted.length, records: sorted };
}
