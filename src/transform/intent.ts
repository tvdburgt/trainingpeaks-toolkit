import type { Workout, StructureStep } from "./workout.js";

/**
 * Controlled vocabulary for workout intent. See `.tp/schema.md` for definitions.
 * Ordered roughly by specificity — more specific tags take precedence in
 * classification rules.
 */
export type Intent =
  | "recovery"
  | "endurance"
  | "tempo"
  | "sweetspot"
  | "threshold"
  | "vo2"
  | "anaerobic"
  | "neuromuscular"
  | "long"
  | "brick"
  | "test"
  | "strength"
  | "race"
  | "open"
  | "other";

export interface IntentResult {
  intent: Intent;
  /** Short tokens describing why we picked this tag. For diagnosability. */
  signals: string[];
}

/**
 * Rule-based intent classifier.
 *
 * Rules are ordered: the first matching rule wins. Each rule records the
 * signal(s) it fired on so mis-tags can be diagnosed by reading the
 * `intent_signals` field in workouts.jsonl or the <!-- intent: ... --> footer
 * in the week markdown.
 *
 * Signals use a concise syntax:
 *   - "title:<keyword>"     → matched title substring
 *   - "sport:<name>"        → matched sport
 *   - "if<0.75"             → IF band rule fired
 *   - "dur>2h"              → duration band rule fired
 *   - "struct:vo2"          → structure intensity class or target band
 */
export function classifyIntent(w: Workout): IntentResult {
  const signals: string[] = [];
  const title = (w.title ?? "").toLowerCase();
  const desc = (w.description ?? "").toLowerCase();

  // Sport-level shortcuts.
  if (w.sport === "Strength") {
    signals.push("sport:Strength");
    return { intent: "strength", signals };
  }
  if (w.sport === "Race") {
    signals.push("sport:Race");
    return { intent: "race", signals };
  }
  if (w.sport === "Brick") {
    signals.push("sport:Brick");
    return { intent: "brick", signals };
  }
  if (w.sport === "Day Off") {
    signals.push("sport:DayOff");
    return { intent: "recovery", signals };
  }

  // Title keyword rules (Dutch + English). Title is the strong signal; description
  // text is too noisy ("rustig tempo" = easy pace, not a tempo session). Fall back
  // to description only when the title yielded no match.
  let kw = matchKeyword(title);
  if (kw) {
    signals.push(`title:${kw.signal}`);
  } else {
    const kwDesc = matchKeyword(desc);
    if (kwDesc && kwDesc.decisive) {
      // Only honor description matches for decisive tags (race, test, recovery, vo2).
      signals.push(`desc:${kwDesc.signal}`);
      kw = kwDesc;
    }
  }
  if (kw && kw.decisive) {
    return { intent: kw.intent, signals };
  }

  // Structure-derived rules.
  const structIntent = intentFromStructure(w.structure);
  if (structIntent) {
    signals.push(`struct:${structIntent.signal}`);
    return { intent: structIntent.intent, signals };
  }

  // IF-band rules (only meaningful if we have IF; use planned when actual absent).
  const ifv = w.actual.intensityFactor ?? w.planned.intensityFactor;
  if (ifv !== undefined) {
    if (ifv < 0.65) {
      signals.push(`if<0.65`);
      // Very easy + long run/bike → endurance (recovery still possible for very short).
      const durS = w.actual.durationSeconds ?? w.planned.durationSeconds ?? 0;
      if (durS < 45 * 60) {
        signals.push("dur<45m");
        return { intent: "recovery", signals };
      }
      return withLongOverride(w, { intent: "endurance", signals });
    }
    if (ifv < 0.76) {
      signals.push(`if0.65-0.76`);
      return withLongOverride(w, { intent: "endurance", signals });
    }
    if (ifv < 0.85) {
      signals.push(`if0.76-0.85`);
      // Could be tempo or sweet spot — prefer keyword hint if present.
      if (kw?.intent === "sweetspot" || kw?.intent === "tempo") {
        return { intent: kw.intent, signals };
      }
      // A "duurloop"/"endurance" title at slightly elevated IF is still endurance.
      if (kw?.intent === "endurance" || kw?.intent === "long") {
        return withLongOverride(w, { intent: "endurance", signals });
      }
      return { intent: "tempo", signals };
    }
    if (ifv < 0.95) {
      signals.push(`if0.85-0.95`);
      if (kw?.intent === "sweetspot") return { intent: "sweetspot", signals };
      return { intent: "threshold", signals };
    }
    if (ifv < 1.05) {
      signals.push(`if0.95-1.05`);
      return { intent: "threshold", signals };
    }
    signals.push(`if>=1.05`);
    return { intent: "vo2", signals };
  }

  // No IF, no structure, no keyword. Duration-based fallback.
  const durS = w.actual.durationSeconds ?? w.planned.durationSeconds ?? 0;
  if (durS >= 3 * 3600) {
    signals.push("dur>=3h");
    return { intent: "long", signals };
  }
  if (durS > 0 && durS < 35 * 60) {
    signals.push("dur<35m");
    return { intent: "recovery", signals };
  }

  return { intent: "open", signals };
}

interface KeywordHit {
  signal: string;
  intent: Intent;
  decisive: boolean;
}

function matchKeyword(hay: string): KeywordHit | null {
  // Race / test (decisive — title usually definitive)
  if (/\b(race|wedstrijd)\b/.test(hay)) return { signal: "race", intent: "race", decisive: true };
  if (/\b(test|ftp test|ltp test|css test|5k test|20min test|benchmark)\b/.test(hay))
    return { signal: "test", intent: "test", decisive: true };

  // VO2 / intervals (decisive when explicitly named)
  if (/\bvo2\b/.test(hay)) return { signal: "vo2", intent: "vo2", decisive: true };
  if (/\b(neuromusc|sprints?|max power|pe ?max)\b/.test(hay))
    return { signal: "neuromuscular", intent: "neuromuscular", decisive: true };
  if (/\banaerob/.test(hay))
    return { signal: "anaerobic", intent: "anaerobic", decisive: true };

  // Endurance / long / recovery keywords. Check before generic "tempo" so a
  // title like "Lange duurloop tempo Z2" still maps to endurance/long.
  if (/\b(long ride|long run|lange duurrit|lange duurloop|lang\b)/.test(hay))
    return { signal: "long", intent: "long", decisive: false }; // defer to duration override
  if (/\b(duurrit|duurloop|endurance|duuzr|duurtrainin)/.test(hay))
    return { signal: "endurance", intent: "endurance", decisive: false };
  if (/\b(herstel|recovery|recoverloop|recoverride|easy spin)/.test(hay))
    return { signal: "recovery", intent: "recovery", decisive: true };

  // Threshold / sweetspot / tempo (hint — combined with IF)
  if (/\b(threshold|drempel|lactaatdrempel|anand|an ?drempel)\b/.test(hay))
    return { signal: "threshold", intent: "threshold", decisive: false };
  if (/\b(sweet ?spot|sst)\b/.test(hay))
    return { signal: "sweetspot", intent: "sweetspot", decisive: false };
  if (/\btempo\b/.test(hay))
    return { signal: "tempo", intent: "tempo", decisive: false };

  // Interval generics (defer to IF)
  if (/\b(intervall?en|intervals)\b/.test(hay))
    return { signal: "intervals", intent: "threshold", decisive: false };

  return null;
}

function intentFromStructure(
  structure: StructureStep[] | undefined,
): { intent: Intent; signal: string } | null {
  if (!structure || structure.length === 0) return null;

  // Collect all work-class steps' intensity bands. Only percent-style metrics
  // are comparable to the band thresholds below (which are calibrated against
  // %FTP / %LTHR / %threshold-pace). Absolute watts/bpm/pace would land at
  // very different numeric ranges and produce nonsense bands.
  const bands: Array<{ min: number; max: number }> = [];
  const classes = new Set<string>();
  walk(structure, (s) => {
    if (s.kind === "step") {
      if (s.intensityClass) classes.add(s.intensityClass);
      const isPercent =
        s.intensityUnit === undefined ||
        s.intensityUnit === "percentOfFtp" ||
        s.intensityUnit === "percentOfThresholdHr" ||
        s.intensityUnit === "percentOfThresholdPace" ||
        s.intensityUnit === "percentOfThresholdSwimPace" ||
        s.intensityUnit === "percentOfMaxHr";
      if (
        s.intensityClass === "active" &&
        isPercent &&
        s.intensityMin !== undefined &&
        s.intensityMax !== undefined
      ) {
        bands.push({ min: s.intensityMin, max: s.intensityMax });
      }
    }
  });

  if (bands.length === 0) return null;

  // Use the highest work-target band as the intent anchor.
  const maxBand = bands.reduce((a, b) => (b.max > a.max ? b : a));
  const mid = (maxBand.min + maxBand.max) / 2;
  if (mid >= 106) return { intent: "vo2", signal: "vo2-target" };
  if (mid >= 95) return { intent: "threshold", signal: "threshold-target" };
  if (mid >= 88) return { intent: "sweetspot", signal: "sst-target" };
  if (mid >= 80) return { intent: "tempo", signal: "tempo-target" };
  if (mid >= 70) return { intent: "endurance", signal: "z2-target" };
  if (mid > 0) return { intent: "recovery", signal: "z1-target" };
  return null;
}

function walk(steps: StructureStep[], fn: (s: StructureStep) => void): void {
  for (const s of steps) {
    fn(s);
    if (s.kind === "repeat") walk(s.steps, fn);
  }
}

/** Promote endurance → long if the workout is ≥3h or explicitly titled "long". */
function withLongOverride(w: Workout, base: IntentResult): IntentResult {
  const durS = w.actual.durationSeconds ?? w.planned.durationSeconds ?? 0;
  if (durS >= 3 * 3600 && base.intent === "endurance") {
    return { intent: "long", signals: [...base.signals, "dur>=3h"] };
  }
  return base;
}

/**
 * Compute share-of-TSS by intent across a set of workouts.
 * Returns a map intent → fraction (0..1), sorted by share desc.
 */
export function intentMix(workouts: Workout[]): Map<Intent, number> {
  const totals = new Map<Intent, number>();
  let grand = 0;
  for (const w of workouts) {
    const tss = w.actual.tss ?? w.planned.tss ?? 0;
    if (tss <= 0) continue;
    const { intent } = classifyIntent(w);
    totals.set(intent, (totals.get(intent) ?? 0) + tss);
    grand += tss;
  }
  if (grand === 0) return new Map();
  const out = new Map<Intent, number>();
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sorted) {
    out.set(k, Math.round((v / grand) * 100) / 100);
  }
  return out;
}
