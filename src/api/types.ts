// Raw-ish shapes from TrainingPeaks internal API. Only fields we read.
// Based on the reference MCP source code in JamsusMaximus/trainingpeaks-mcp.

export interface TPUserResponse {
  user?: TPUser;
  // Some endpoints return the user object directly at the root.
  [key: string]: unknown;
}

export interface TPUser {
  personId?: number;
  userId?: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  timeZone?: string; // IANA tz, e.g. "Europe/Amsterdam"
  settings?: {
    timeZone?: string;
  };
  athletes?: TPAthleteRef[];
}

export interface TPAthleteRef {
  athleteId?: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  coachedBy?: number;
}

export interface TPWorkoutListItem {
  workoutId: number;
  athleteId?: number;
  workoutDay?: string; // "YYYY-MM-DDTHH:mm:ss"
  startTime?: string | null;
  startTimePlanned?: string | null;
  title?: string;
  description?: string;
  coachComments?: string;
  workoutComments?: TPWorkoutComment[];
  workoutTypeValueId?: number;
  workoutTypeId?: number;
  /** Hours (not seconds). */
  totalTime?: number | null;
  /** Hours. */
  totalTimePlanned?: number | null;
  distance?: number | null;
  distancePlanned?: number | null;
  tssActual?: number | null;
  tssPlanned?: number | null;
  /** Actual intensity factor — field is literally "if". */
  if?: number | null;
  ifPlanned?: number | null;
  velocityAverage?: number | null;
  velocityMaximum?: number | null;
  heartRateAverage?: number | null;
  heartRateMaximum?: number | null;
  cadenceAverage?: number | null;
  cadenceMaximum?: number | null;
  powerAverage?: number | null;
  powerMaximum?: number | null;
  normalizedPowerActual?: number | null;
  energy?: number | null;
  elevationGain?: number | null;
  elevationLoss?: number | null;
  calories?: number | null;
  /** Always null in observed data — do not rely on this to infer completion. */
  completed?: boolean | null;
  lastModifiedDate?: string;
  structure?: TPStructure | null;
  [key: string]: unknown;
}

/**
 * One entry in a workout's discussion thread (athlete ↔ coach exchange after
 * the planned workout was created). Posted via the TP UI and returned inline
 * with each workout in the list endpoint — no separate fetch needed.
 */
export interface TPWorkoutComment {
  id?: number;
  comment?: string;
  dateCreated?: string; // ISO timestamp
  workoutId?: number;
  commenterPersonId?: number;
  commenterName?: string;
  firstName?: string;
  lastName?: string;
  isCoach?: boolean;
  commenterPhotoUrl?: string;
}

export interface TPStructure {
  primaryLengthMetric?: string;
  primaryIntensityMetric?: string;
  primaryIntensityTargetOrRange?: string;
  structure?: TPStructureStep[];
  polyline?: unknown[];
}

export interface TPStructureStep {
  type?: string; // "step" | "repetition"
  name?: string;
  length?: { value?: number; unit?: string };
  steps?: TPStructureStep[]; // for repetition
  intensityClass?: string; // warmUp | active | rest | coolDown
  openDuration?: boolean;
  targets?: Array<{
    minValue?: number;
    maxValue?: number;
    unit?: string;
  }>;
}

// Normalised lap shape we produce from TP's raw lapsStats entry.
// All durations in SECONDS, distance in METERS, speed in M/S.
export interface TPLap {
  lapNumber: number;
  name: string | null;
  /** Offset from workout start, seconds. */
  beginOffsetSec: number;
  /** Duration, seconds. */
  elapsedSec: number;
  /** Stopped/pause time inside this lap, seconds. */
  stoppedSec: number;
  distanceMeters: number | null;
  heartRateAverage: number | null;
  heartRateMaximum: number | null;
  powerAverage: number | null;
  powerMaximum: number | null;
  normalizedPower: number | null;
  cadenceAverage: number | null;
  cadenceMaximum: number | null;
  /** Meters per second. */
  speedAverage: number | null;
  speedMaximum: number | null;
  elevationGain: number | null;
  elevationLoss: number | null;
  tssActual: number | null;
  intensityFactor: number | null;
  calories: number | null;
  energy: number | null;
}

// Raw lap entry as returned by /detaildata.lapsStats[].
// Times are MILLISECONDS, distance METERS, speed M/S.
export interface TPRawLapStat {
  name?: string | null;
  begin?: number | null;
  end?: number | null;
  elapsedTime?: number | null;
  stoppedTime?: number | null;
  distance?: number | null;
  averageHeartRate?: number | null;
  maximumHeartRate?: number | null;
  averagePower?: number | null;
  maximumPower?: number | null;
  normalizedPowerActual?: number | null;
  averageCadence?: number | null;
  maximumCadence?: number | null;
  averageSpeed?: number | null;
  maximumSpeed?: number | null;
  elevationGain?: number | null;
  elevationLoss?: number | null;
  trainingStressScoreActual?: number | null;
  intensityFactorActual?: number | null;
  calories?: number | null;
  energy?: number | null;
  [key: string]: unknown;
}

// /fitness/v6/athletes/{id}/workouts/{wid}/detaildata
export interface TPDetailDataResponse {
  workoutId?: number;
  lapsStats?: TPRawLapStat[];
  [key: string]: unknown;
}

// POST /fitness/v1/athletes/{id}/reporting/performancedata/{start}/{end}
// Body: { atlConstant, atlStart, ctlConstant, ctlStart, workoutTypes: [] }
// Returns one row per calendar day in the requested range.
//
// Observation from the live API (2026-04): values at the first row of the
// requested window are already warm-started from the athlete's historical
// TSS — not from ctlStart/atlStart. So requesting just the analysis window
// gives correct CTL/ATL/TSB without any pre-warmup buffer.
export interface TPPerformanceDataPoint {
  /** "YYYY-MM-DDT00:00:00" — the calendar day this point represents. */
  workoutDay?: string;
  tssActual?: number | null;
  tssPlanned?: number | null;
  ctl?: number | null;
  atl?: number | null;
  tsb?: number | null;
  ifActual?: number | null;
  ifPlanned?: number | null;
  [key: string]: unknown;
}

export interface TPPerformanceDataRequest {
  atlConstant: number;
  atlStart: number;
  ctlConstant: number;
  ctlStart: number;
  workoutTypes: number[];
}

export interface TPEvent {
  id?: number;
  eventId?: number;
  name?: string;
  title?: string;
  description?: string;
  eventDate?: string;
  startDate?: string;
  endDate?: string;
  priority?: string; // "A" | "B" | "C"
  priorityId?: number;
  ctlTarget?: number | null;
  workoutTypeId?: number;
  [key: string]: unknown;
}

// Workout type lookup from GET /fitness/v6/workouttypes (verified live).
export const WORKOUT_TYPE_BY_ID: Record<number, string> = {
  1: "Swim",
  2: "Bike",
  3: "Run",
  4: "Brick",
  5: "Cross Train",
  6: "Race",
  7: "Day Off",
  8: "Mountain Bike",
  9: "Strength",
  10: "Custom",
  11: "XC-Ski",
  12: "Rowing",
  13: "Walk",
  29: "Strength",
  100: "Other",
};

// ---------- Athlete settings (`/fitness/v1/athletes/{id}/settings`) ----------

export interface TPZoneBand {
  label: string;
  minimum: number;
  maximum: number;
}

export interface TPZoneGroup {
  /** workoutTypeId 0=general/run, 1=swim, 2=bike. */
  workoutTypeId: number;
  threshold: number;
  /** HR-only fields. */
  maximumHeartRate?: number;
  restingHeartRate?: number;
  calculationMethod?: number;
  zoneCalculatorId?: number | null;
  zones: TPZoneBand[];
}

export interface TPAthleteSettings {
  athleteId: number;
  personId?: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  birthday?: string;
  gender?: string;
  timeZone?: string;
  units?: number;
  heartRateZones?: TPZoneGroup[];
  powerZones?: TPZoneGroup[];
  speedZones?: TPZoneGroup[];
  [key: string]: unknown;
}

// ---------- Metrics (`/metrics/v3/athletes/{id}/consolidatedtimedmetrics`) ----------

/** Subset we read. Type IDs: 5=pulse, 6=sleep_hours, 9=weight, 60=hrv, 53=spo2. */
export interface TPMetricDetail {
  type: number;
  label?: string;
  value: number;
  time?: string; // "YYYY-MM-DDTHH:mm:ss"
  uploadClient?: string | null;
}

export interface TPMetricDay {
  id?: string;
  athleteId?: number;
  /** "YYYY-MM-DDT00:00:00" */
  timeStamp: string;
  details?: TPMetricDetail[];
}


