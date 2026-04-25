import path from "node:path";
import { writeAtomic, exists } from "../io/fs.js";
import { log } from "../util/log.js";

const SCHEMA_CONTENT = `# Schema & glossary

Stable reference for the on-disk data layout. LLMs/analysis tools should load
this file once to understand field meanings before reading week files.

## Workspace layout

\`\`\`
<workspace>/
  .env                       TP_USERNAME, TP_COOKIE (gitignore'd by you)
  ATHLETE.md                 hand-edited: current_block, phase_start, goals[], notes. Never overwritten.
  _generated/                machine-readable + auto-synced files; full rewrite per run
    athlete.tp.md            auto-synced from TrainingPeaks: FTP, LTHR, max HR, weight, zones
    events.md                auto-synced from TrainingPeaks: upcoming + past events/races
    schema.md                this file
    index.md                 auto-generated dashboard (last 12w, A-race countdown, current block)
    workouts.jsonl           one JSON object per workout (past + future)
    load.jsonl               one JSON object per calendar day (PMC series)
    laps/<id>.json           per-workout lap array (sidecar, referenced by workouts.jsonl)
    structure/<id>.json      per-workout planned-interval tree (sidecar)
  YYYY/NN.md                 one file per ISO week (narrative surface; workouts only — events live in _generated/events.md)
\`\`\`

The on-disk files are themselves the sync cache. \`tp pull\` re-pulls the
current ISO week and any missing older weeks; everything under \`_generated/\`
is fully rewritten every run. There is no separate state file.

## Units

All units are SI/seconds/meters unless suffixed:

- \`duration_s\`: integer seconds
- \`distance_m\`: integer meters
- \`speed_avg_mps\`: meters per second
- \`elev_*_m\`: integer meters
- \`power_*\`: watts
- \`hr_*\`: bpm
- \`tss\`: Training Stress Score (TP's definition)
- \`if\`: Intensity Factor (0..~1.2)
- \`ctl\`, \`atl\`, \`tsb\`: TrainingPeaks PMC values, one decimal

## \`workouts.jsonl\` record

Every record has the same top-level shape. Missing values are \`null\` (not
omitted) so downstream consumers can rely on the key set.

\`\`\`jsonc
{
  "workout_id": 3625927596,
  "date": "2026-04-20",          // YYYY-MM-DD in athlete timezone
  "iso_year": 2026,
  "iso_week": 17,
  "dow": 1,                      // 1 = Monday .. 7 = Sunday
  "start_time": "09:00",         // "HH:mm" in athlete tz, or null
  "sport": "Swim",
  "title": "...",
  "status": "completed",         // "completed" | "planned"
  "intent": "endurance",         // see intent vocabulary below
  "intent_signals": ["title:duurrit","if0.65-0.76"],
  "planned":  { "duration_s": ..., "distance_m": ..., "tss": ..., "if": ... },
  "actual":   { "duration_s": ..., "distance_m": ..., "tss": ..., "if": ...,
                "hr_avg": ..., "hr_max": ..., "power_avg": ...,
                "power_np": ..., "power_max": ..., "cadence_avg": ...,
                "speed_avg_mps": ..., "elev_gain_m": ..., "elev_loss_m": ...,
                "calories": ... },
  "compliance": { "duration": 0.89, "tss": 0.82 }, // actual/planned ratio, null if no plan
  "description": "...",          // pre-workout notes
  "coach_instruction": "...",    // static instruction set on the planned workout
  "discussion": [                // athlete ↔ coach thread, oldest first
    { "author": "Tijmen van der Burgt", "role": "athlete",
      "posted_at": "2026-04-17T07:54:37Z", "text": "..." },
    { "author": "Roland de Haan (COACH)", "role": "coach",
      "posted_at": "2026-04-17T19:32:43Z", "text": "..." }
  ],
  "structure_ref": "structure/3625927596.json",  // null when no planned structure
  "laps_ref":      "laps/3625927596.json",       // null when no device laps
  "last_modified": "2026-04-19T23:40:07",
  "source": "trainingpeaks"
}
\`\`\`

## \`load.jsonl\` record

One record per calendar day in the analysis window. Sourced from TrainingPeaks'
Performance Management Chart endpoint — CTL/ATL are warm-started from the
athlete's full history, so values are correct from day 1 of the window.

\`\`\`jsonc
{
  "date": "2026-03-16",
  "tss_actual":  60,              // sum across workouts that day
  "tss_planned": 50,
  "if_actual":  0.63,
  "if_planned": 0.67,
  "ctl":  72.4,                   // 42-day EWMA
  "atl":  68.1,                   // 7-day EWMA
  "tsb":   4.3                    // ctl - atl
}
\`\`\`

## Week file frontmatter

\`\`\`yaml
iso_year, iso_week, date_range, timezone, athlete_id
phase: past | current | future
totals: { sessions, duration_min, distance_km, tss, elev_gain_m }
by_sport:                         # block style; one sport per nested map
  Bike: { sessions, duration_min, distance_km, tss }
load:                             # present for every week in the PMC window
  ctl_end, atl_end, tsb_end, weekly_tss, ramp_rate, monotony, strain
intent_mix:                       # share of weekly TSS by intent (0..1)
  endurance: 0.62
  threshold: 0.18
  ...
adherence:                        # past weeks only
  sessions_completed, sessions_planned, tss_actual_vs_planned
generated_at: ISO timestamp
source: trainingpeaks
\`\`\`

## Structured-workout targets

When a planned workout has a step structure (visible in week files under
\`**Planned structure**\` and in \`_generated/structure/<id>.json\`), each step
records an intensity range with a unit. The unit is normalised to one of:

| \`intensityUnit\` | Meaning | Rendered as |
|---|---|---|
| \`percentOfFtp\` | % of cycling FTP | \`@ 110–130% FTP\` |
| \`percentOfThresholdHr\` | % of LTHR | \`@ 80–88% LTHR\` |
| \`percentOfMaxHr\` | % of max HR | \`@ 75–85% max HR\` |
| \`percentOfThresholdPace\` | % of run threshold pace | \`@ 95–105% threshold pace\` |
| \`percentOfThresholdSwimPace\` | % of swim CSS | \`@ 95–105% CSS\` |
| \`heartRate\` | absolute bpm | \`@ 145–155 bpm\` |
| \`power\` | absolute watts | \`@ 240–280 W\` |
| \`pace\` / \`meterPerSecond\` | run/swim pace | \`@ 4:30–4:15/km\` |
| \`rpe\` | rate of perceived exertion (1–10) | \`@ RPE 7–8\` |
| \`kilometerPerHour\` / \`milePerHour\` | absolute speed | \`@ 28–32 km/h\` |

Notes:

- Equal min/max collapses to a single value (\`@ 85% FTP\`).
- Open-ended ranges render as \`≥X\` or \`≤Y\`.
- Pace ranges flip min/max because lower seconds-per-km = faster.
- Cadence is a *secondary* target and renders as \`(cad 100–120 rpm)\` after the
  primary intensity, except when the step name already mentions cadence
  ("Hoge cadans", "high cadence").
- TrainingPeaks plans most often use percent-of-threshold metrics; absolute
  units appear when a coach overrides the workout-builder defaults.

## Intent vocabulary

Controlled vocabulary applied by a rule-based classifier. First matching rule
wins; the rule that fired is recorded in \`intent_signals\` for diagnosability.

| Intent | Typical IF | Typical target | Typical title keywords |
|---|---|---|---|
| \`recovery\` | < 0.65 (short) | Z1 power/HR | herstel, recovery, easy spin |
| \`endurance\` | 0.65–0.76 | Z2 power/HR | duurrit, duurloop, endurance |
| \`tempo\` | 0.76–0.85 | 80–88% FTP | tempo |
| \`sweetspot\` | 0.85–0.95 | 88–93% FTP | sweet spot, SST |
| \`threshold\` | 0.95–1.05 | 95–105% FTP | threshold, drempel, anand |
| \`vo2\` | ≥ 1.05 | 106–120% FTP | VO2 |
| \`anaerobic\` | — | > 120% FTP | anaerob |
| \`neuromuscular\` | — | max-effort short | sprints, max power, neuromusc |
| \`long\` | 0.65–0.76 | Z2 but ≥ 3h | long ride / long run |
| \`brick\` | — | — | sport = Brick |
| \`test\` | — | — | FTP test, LTP test, 20min test |
| \`strength\` | — | — | sport = Strength |
| \`race\` | — | — | sport = Race OR title match |
| \`open\` | — | — | unclassified |
| \`other\` | — | — | no signals matched |

## Load math

\`\`\`
CTL_today = CTL_yesterday + (TSS_today − CTL_yesterday) / 42      # 42-day EWMA
ATL_today = ATL_yesterday + (TSS_today − ATL_yesterday) / 7       # 7-day EWMA
TSB_today = CTL_today − ATL_today                                 # form
ramp_rate = CTL_end(week) − CTL_end(prior week)                   # Δ per week
weekly_TSS = Σ(daily TSS over ISO week)
monotony = mean(daily TSS) / stdev(daily TSS)                     # null if sd = 0
strain = monotony × weekly_TSS                                    # null if monotony null
\`\`\`

Values come directly from TrainingPeaks; we only compute ramp_rate / monotony /
strain locally.

## Timezones

All dates and \`start_time\` values are in the athlete's timezone (see
frontmatter \`timezone:\`). ISO week assignment uses the same timezone.

## Compliance

\`\`\`
compliance.duration = actual.duration_s / planned.duration_s    # null if no plan
compliance.tss      = actual.tss        / planned.tss
\`\`\`

A value of 1.0 means executed as planned; 0.0 means missed. Values > 1.0 are
common (overcooking or late-added effort).
`;

export async function ensureSchemaFile(outDir: string): Promise<string> {
  const p = path.join(outDir, "_generated", "schema.md");
  if (!(await exists(p))) {
    await writeAtomic(p, SCHEMA_CONTENT);
    log.info(`Created ${path.relative(outDir, p)}`);
  }
  return p;
}

/** Force-rewrite the schema file. Use when upgrading the toolkit. */
export async function writeSchemaFile(outDir: string): Promise<string> {
  const p = path.join(outDir, "_generated", "schema.md");
  await writeAtomic(p, SCHEMA_CONTENT);
  return p;
}
