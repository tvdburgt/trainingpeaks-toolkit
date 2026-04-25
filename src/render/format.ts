export function fmtDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return sec > 0 ? `${m}m${String(sec).padStart(2, "0")}s` : `${m}m`;
  return `${sec}s`;
}

export function fmtLapDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function fmtKm(meters: number | undefined): string {
  if (meters === undefined || !Number.isFinite(meters) || meters <= 0) return "—";
  return `${(meters / 1000).toFixed(meters < 10_000 ? 2 : 1)} km`;
}

export function fmtMeters(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  return `${Math.round(v)} m`;
}

export function fmtInt(v: number | undefined, unit = ""): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  return `${Math.round(v)}${unit ? ` ${unit}` : ""}`;
}

export function fmtFloat(v: number | undefined, digits = 2, unit = ""): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}${unit ? ` ${unit}` : ""}`;
}

/** m/s -> min/km string, for run/swim paces. */
export function fmtPaceFromMps(mps: number | undefined): string {
  if (mps === undefined || !Number.isFinite(mps) || mps <= 0) return "—";
  const secPerKm = 1000 / mps;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

export function fmtPct(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(2)}`;
}

/** Escape a value to be safe inside a markdown table cell. */
export function tcell(s: string): string {
  return s.replaceAll("|", "\\|").replaceAll("\n", " ");
}
