import type { Workout } from "./workout.js";
import { isoWeekOf } from "../util/isoWeek.js";

export interface WeekBucket {
  isoYear: number;
  isoWeek: number;
  key: string;
  workouts: Workout[];
}

export function groupByWeek(
  workouts: Workout[],
  timezone: string,
): Map<string, WeekBucket> {
  const map = new Map<string, WeekBucket>();

  function get(instant: Date): WeekBucket {
    const w = isoWeekOf(instant, timezone);
    let bucket = map.get(w.key);
    if (!bucket) {
      bucket = {
        isoYear: w.isoYear,
        isoWeek: w.isoWeek,
        key: w.key,
        workouts: [],
      };
      map.set(w.key, bucket);
    }
    return bucket;
  }

  for (const wkt of workouts) get(wkt.instant).workouts.push(wkt);

  // Sort within each bucket.
  for (const bucket of map.values()) {
    bucket.workouts.sort(
      (a, b) => a.instant.getTime() - b.instant.getTime() || a.id - b.id,
    );
  }

  return map;
}
