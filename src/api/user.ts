import { TPClient } from "../client.js";
import { log } from "../util/log.js";
import type { TPUser, TPUserResponse } from "./types.js";

export interface ResolvedAthlete {
  athleteId: number;
  timezone: string;
  firstName?: string;
  lastName?: string;
  user: TPUser;
}

export async function fetchUser(client: TPClient): Promise<TPUser> {
  const raw = await client.get<TPUserResponse>("/users/v3/user");
  const user = (raw?.user ?? raw) as TPUser;
  if (!user) throw new Error("Empty user response");
  return user;
}

export function resolveAthleteId(user: TPUser, override: number | undefined): number {
  if (override !== undefined) return override;

  const personId = user.personId;
  const athletes = user.athletes ?? [];

  // Default: find the user's own athlete entry (non-coach or coach-as-athlete).
  if (athletes.length > 0) {
    const email = (user.email ?? "").toLowerCase();
    const lastName = (user.lastName ?? "").toLowerCase();

    // 1. Match by coachedBy=self and email.
    for (const a of athletes) {
      if (a.athleteId && a.coachedBy === personId && (a.email ?? "").toLowerCase() === email) {
        return a.athleteId;
      }
    }
    // 2. Match by last name.
    for (const a of athletes) {
      if ((a.lastName ?? "").toLowerCase() === lastName && a.coachedBy === personId && a.athleteId) {
        return a.athleteId;
      }
    }
  }

  if (personId) return personId;
  if (athletes[0]?.athleteId) return athletes[0].athleteId;

  throw new Error("Could not resolve athlete id from user response.");
}

export function resolveTimezone(user: TPUser): string {
  const tz = user.settings?.timeZone ?? user.timeZone;
  if (!tz) {
    log.warn("No timezone on user profile; falling back to UTC");
    return "UTC";
  }
  return tz;
}
