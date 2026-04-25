# trainingpeaks-toolkit

Mirror your TrainingPeaks workouts and races to local markdown files, one file per ISO week — and (later) plan ahead from them.

- No partner-API approval needed — uses the same internal web API (`tpapi.trainingpeaks.com`) that `app.trainingpeaks.com` talks to.
- Auth is your TrainingPeaks username/password. The toolkit logs in for you (pure Node, no headless browser) and caches the resulting session cookie in `.env`. Auto-refreshed when expired.
- Incremental: the files on disk are the source of truth. Each run re-pulls the current ISO week and any missing older weeks. Delete a week file to regenerate it.

## Install

```powershell
cd D:\anta\trainingpeaks-toolkit
npm install
npm run build
npm link
```

After `npm link`, the `tp` command is available globally on your PATH. Re-run `npm run build` after changing source.

Node 20+ required. Runs on Windows, macOS, and headless Linux.

## Workspace

A **workspace** is a directory on your machine that holds one athlete's training data. It is the unit `tp` operates on: every `tp` command runs against the workspace identified by the current working directory (the directory containing `.env`).

A workspace is *not* this repository. The repo is the source code for `tp`; a workspace is the data `tp` produces and reads. You typically have one workspace per athlete, somewhere outside the repo, version-controlled separately (or not at all).

A workspace contains:

- **`.env`** — credentials for this athlete (`TP_USERNAME`, `TP_COOKIE`, optional `TP_ATHLETE_ID`). Created by `tp init`. Treat as secret.
- **`ATHLETE.md`** — the only hand-edited file. Holds your current training block, A-races, and any free-form notes you want an LLM to see. Never overwritten by `tp pull`.
- **Year directories `2024/`, `2025/`, …** — one markdown file per ISO week (`<isoYear>/<NN>.md`). Generated.
- **`_generated/`** — everything else `tp` writes: synced TP profile mirror (`athlete.tp.md`), race calendar (`events.md`), dashboard (`index.md`), schema/glossary for LLMs (`schema.md`), and machine-readable datasets (`workouts.jsonl`, `load.jsonl`, `laps/`, `structure/`). Full rewrite per run; do not hand-edit.

The on-disk files are themselves the sync cache — `tp pull` re-pulls the current ISO week and any missing older weeks, and rewrites `_generated/` from scratch each run. There is no separate state file.

Create one with:

```powershell
tp init D:\path\to\my-workspace
cd D:\path\to\my-workspace
tp pull
```

Subsequent `tp pull` / `tp authenticate` invocations must be run from inside the workspace (cwd-sensitive — they read and write `.env` and the surrounding files).

## Auth

`tp init` prompts for your TrainingPeaks **username** (visible) and **password** (hidden), logs in, verifies against the API, and writes:

- `TP_USERNAME` (cached)
- `TP_COOKIE` (the session cookie minted by login)

…to `.env` in the workspace directory. The password is **not** persisted.

### Cookie expiry & auto-refresh

Sessions expire after a few weeks. The toolkit handles this automatically when:

1. `TP_USERNAME` is in `.env` (set by `tp init`), AND
2. `TP_PASSWORD` is exported in the environment when `tp pull` runs.

When the token endpoint rejects the cookie, the toolkit logs in fresh, writes the new `TP_COOKIE` back to `.env`, and continues. You'll see:

```
INFO Cookie expired, refreshing…
INFO Refreshed.
```

If `TP_PASSWORD` is not available, `tp pull` will fail with an auth error — recover with:

```
tp authenticate
```

…which prompts for the password (or reads `TP_PASSWORD` if set), logs in, and rewrites `TP_COOKIE`.

### Non-interactive use (cron / CI)

Both `tp init` and `tp authenticate` accept `--username USER`, and read `TP_USERNAME` / `TP_PASSWORD` from the environment when present. Example unattended pull:

```bash
export TP_PASSWORD='...'
tp pull
```

Password should never be passed as a CLI flag (would leak into shell history / `ps`).

### Security

`.env` contains a session cookie (and your username). Treat it as a secret. On POSIX systems `tp init` `chmod 600`s it for you; on Windows, restrict access via NTFS ACLs if needed.

## Run

```powershell
# after `npm link`, tp is on your PATH:
tp pull --verbose

# or without linking:
npm run dev -- pull --verbose       # dev (tsx, no build)
npm run build; npm start -- pull    # prod build
```

### CLI

```
tp                          list subcommands
tp init                     scaffold a new workspace (interactive)
tp init <dir>               scaffold a workspace at <dir>
tp authenticate             refresh the session cookie (run inside a workspace)
tp pull                     pull last 52 ISO weeks (~1 year, default)
tp pull --weeks 104         pull last 104 ISO weeks (~2 years)
tp pull --dry-run           fetch + render without writing
tp pull --athlete 1234567   target a specific athlete (coach accounts)
tp pull --verbose
tp plan                     (not yet implemented — draft proposed weeks)
tp config                   (not yet implemented — inspect resolved config)
```

Incremental behaviour:

- The current ISO week is always re-pulled (catches workouts uploaded today).
- Older weeks in the window are only pulled when `<isoYear>/<NN>.md` is missing in the workspace.
- Delete any week file to regenerate it on the next run.
- Weeks are processed **newest-first**, so an interrupted run still leaves you with the most recent data on disk.

### Workspace layout

After `tp init` + `tp pull`, the workspace looks like:

```
my-workspace/
  .env                 credentials (gitignore!)
  ATHLETE.md           hand-edited: current_block, goals, notes
  _generated/
    athlete.tp.md      synced from TP: FTP, LTHR, zones, weight
    events.md          synced: race calendar
    index.md           generated: dashboard
    schema.md          generated: field reference for LLMs
    workouts.jsonl     dataset: one line per workout
    load.jsonl         dataset: one line per day (CTL/ATL/TSB)
    laps/<id>.json     per-workout lap sidecar
    structure/<id>.json per-workout planned-interval sidecar
  2024/
    01.md
    02.md
    ...
  2025/
    01.md
    ...
  2026/
    17.md
```

Filenames use ISO 8601 week-year + zero-padded ISO week, so `2024-12-30` lives in `2025/01.md`, and 53-week years work.

### Markdown format

Each week file has:

- YAML front-matter with machine-readable totals (by sport, events count, tz, athlete id, generated timestamp).
- Week totals table.
- An **Events** section (races + priority) if the week has any.
- One H2 per day, one H3 per workout.
- Each workout: planned-vs-actual stats table, description (blockquote), planned interval structure (nested list), lap splits table.

## What it fetches

- Workouts: id, date, planned start time, sport/title, planned + actual duration/distance/TSS/IF, HR, power (avg/NP/max), cadence, pace, elevation, calories, description, coach notes, planned interval structure, lap splits.
- Events: date, title, priority (A/B/C), sport, CTL target, description.

Not included (v1): health metrics (weight/HRV/sleep), equipment, time-series samples.

## How it works

See [PLAN.md](./PLAN.md) for the full design.

Short version:

1. `POST home.trainingpeaks.com/login` with username/password → `Production_tpAuth` session cookie.
2. `GET tpapi.trainingpeaks.com/users/v3/token` with that cookie → OAuth bearer.
3. `GET /users/v3/user` → athlete id + IANA timezone.
4. Determine target ISO weeks (current week + any missing files within the last `--weeks N`), newest first.
5. `GET /fitness/v6/athletes/{id}/workouts/{start}/{end}` in ≤45-day chunks, covering the target weeks.
6. For each completed workout with recorded device data: `GET /fitness/v6/athletes/{id}/workouts/{wid}/detaildata` → laps.
7. `GET /fitness/v1/athletes/{id}/events/{start}/{end}` for races.
8. Group by ISO week **in athlete tz**, render markdown, write one file per week (atomic).

## Caveats

- This uses TrainingPeaks' internal API (the one their web app calls). Endpoints can change without notice.
- The login form renders an invisible reCAPTCHA v3, but server-side enforcement is currently advisory (verified empirically). If TP tightens this, the pure-Node login will start failing and the toolkit will need a headless-browser path.
