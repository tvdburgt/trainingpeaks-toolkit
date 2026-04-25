import readline from "node:readline";

/**
 * Lightweight stdin prompts for interactive CLI flows. Pure stdlib — we
 * deliberately avoid pulling a prompts library to keep the dependency
 * footprint tiny.
 *
 * All helpers throw if stdin is not a TTY (so callers can degrade gracefully
 * for piped/automated invocations).
 */

function requireTTY(): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Interactive prompt required, but stdin is not a TTY. " +
        "Run `tp init` from a terminal, or pre-populate .env and run `tp pull`.",
    );
  }
}

/** Ask a free-text question. Returns trimmed input; falls back to `def` on empty. */
export async function ask(question: string, def?: string): Promise<string> {
  requireTTY();
  const suffix = def !== undefined ? ` [${def}]` : "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question}${suffix}: `, (a) => resolve(a));
    });
    const trimmed = answer.trim();
    return trimmed === "" && def !== undefined ? def : trimmed;
  } finally {
    rl.close();
  }
}

/** Yes/no confirmation. `def` is the default applied on empty input. */
export async function confirm(question: string, def = true): Promise<boolean> {
  const hint = def ? "Y/n" : "y/N";
  const a = (await ask(`${question} (${hint})`, def ? "y" : "n")).toLowerCase();
  return a === "y" || a === "yes";
}

/**
 * Ask for a secret value (cookie, token). Echoes `*` per keystroke and
 * confirms received length after submit. Reads keystrokes in raw mode so
 * the typed characters never appear on screen.
 */
export async function askSecret(question: string): Promise<string> {
  requireTTY();
  process.stdout.write(`${question}: `);

  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    let buf = "";

    const wasRaw = stdin.isRaw;
    try {
      stdin.setRawMode(true);
    } catch (err) {
      reject(err as Error);
      return;
    }
    stdin.resume();
    stdin.setEncoding("utf8");

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\n" || ch === "\r") {
          cleanup();
          process.stdout.write(`\n  (received ${buf.length} chars)\n`);
          resolve(buf);
          return;
        }
        if (code === 3) {
          // Ctrl-C
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          // Backspace
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (code < 32) continue; // ignore other control chars
        buf += ch;
        process.stdout.write("*");
      }
    };

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        /* ignore */
      }
      stdin.pause();
    };

    stdin.on("data", onData);
  });
}
