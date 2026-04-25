export type LogLevel = "debug" | "info" | "warn" | "error";

let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

function fmt(level: LogLevel, msg: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] ${level.toUpperCase()} ${msg}`;
}

export const log = {
  debug(msg: string): void {
    if (verbose) console.error(fmt("debug", msg));
  },
  info(msg: string): void {
    console.error(fmt("info", msg));
  },
  warn(msg: string): void {
    console.error(fmt("warn", msg));
  },
  error(msg: string): void {
    console.error(fmt("error", msg));
  },
};
