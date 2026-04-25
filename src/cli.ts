#!/usr/bin/env node
import { AuthError } from "./auth.js";
import { APIError } from "./client.js";
import { LoginError } from "./login.js";

type CommandHandler = (argv: string[]) => Promise<void>;

const commands: Record<string, { load: () => Promise<CommandHandler>; summary: string }> = {
  init: {
    load: async () => (await import("./commands/init.js")).run,
    summary: "Scaffold a new workspace (interactive)",
  },
  authenticate: {
    load: async () => (await import("./commands/authenticate.js")).run,
    summary: "Refresh the TrainingPeaks session cookie in the current workspace",
  },
  pull: {
    load: async () => (await import("./commands/pull.js")).run,
    summary: "Sync TrainingPeaks workouts and events into the current workspace",
  },
  plan: {
    load: async () => (await import("./commands/plan.js")).run,
    summary: "Draft proposed training weeks (not yet implemented)",
  },
  config: {
    load: async () => (await import("./commands/config.js")).run,
    summary: "Inspect resolved configuration (not yet implemented)",
  },
};

function printRootHelp(): void {
  const lines = [
    "tp — TrainingPeaks toolkit",
    "",
    "Usage:",
    "  tp <command> [options]",
    "",
    "Commands:",
  ];
  const pad = Math.max(...Object.keys(commands).map((n) => n.length));
  for (const [name, cmd] of Object.entries(commands)) {
    lines.push(`  ${name.padEnd(pad)}  ${cmd.summary}`);
  }
  lines.push("", "Run `tp <command> --help` for command-specific options.");
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    printRootHelp();
    return;
  }

  const name = argv[0];
  const cmd = commands[name];
  if (!cmd) {
    console.error(`Unknown command: ${name}\n`);
    printRootHelp();
    process.exit(64);
  }

  const handler = await cmd.load();
  await handler(argv.slice(1));
}

main().catch((err) => {
  if (err instanceof AuthError) {
    console.error(`\nAuth error: ${err.message}\n`);
    process.exit(2);
  }
  if (err instanceof LoginError) {
    console.error(`\nLogin error: ${err.message}\n`);
    process.exit(2);
  }
  if (err instanceof APIError) {
    console.error(`\nAPI error (status ${err.status}): ${err.message}\n`);
    process.exit(3);
  }
  console.error(err);
  process.exit(1);
});
