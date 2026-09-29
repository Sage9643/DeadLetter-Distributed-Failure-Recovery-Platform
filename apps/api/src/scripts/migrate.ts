// Phase 17: production-grade migration runner.
//
// Problem this replaces: infra/init-db/*.sql (mounted at
// /docker-entrypoint-initdb.d in the postgres image) only executes
// automatically the FIRST time a Postgres container starts against an
// EMPTY data volume. Every deployment after that -- including this
// project's own real history, see docs/database.md's Phase 6 and
// Phase 10 entries -- required someone to notice a new .sql file
// existed and run it BY HAND against the live database. That is a
// real gap that has already caused manual, undocumented-until-after-
// the-fact schema changes twice in this project. This script is the
// smallest fix that removes the manual step without adding a
// migration framework/ORM this project does not otherwise need.
//
// Design:
// - A single ledger table, schema_migrations, records which migration
//   filenames have been applied and when. Plain SQL files, applied in
//   filename order (the existing NNN_description.sql numbering already
//   sorts correctly).
// - Every file this project has today already writes its own DDL
//   defensively (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
//   EXISTS) as a matter of the style already in use -- this script
//   does not depend on that, but it means running an already-applied
//   file again would be harmless even without the ledger. The ledger
//   exists so that stays true for FUTURE migrations too (a data
//   backfill or a destructive change is not automatically safe to
//   re-run), and so there is an auditable record of what has actually
//   been applied to a given database.
// - A Postgres advisory lock is held for the duration of the run, so
//   two migrate runs racing (e.g. a redeploy triggered twice) cannot
//   both try to apply the same pending file concurrently.
// - Each migration file runs inside its own transaction: the file's
//   SQL plus its ledger insert either both commit or both roll back.
//   A failing file stops the run immediately (later files are not
//   attempted) and exits non-zero -- this script never silently skips
//   a failure.
// - Intentionally NOT a general-purpose migration framework: no down-
//   migrations, no dry-run mode, no checksum verification of already-
//   applied files. This project's migrations so far are additive-only
//   (new tables, new nullable/defaulted columns) and small in number;
//   a rollback story more elaborate than "restore the Postgres volume
//   snapshot taken before deploying" has not been needed, and adding
//   one now would be solving a problem this project doesn't have yet
//   (see docs/engineering-decisions.md's stated anti-overengineering
//   rule).

import { Client } from "pg";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// Fixed, arbitrary 64-bit key for the advisory lock. Any two processes
// using this same key serialize against each other; the specific value
// only needs to be constant and unlikely to collide with an unrelated
// use of advisory locks against the same database.
const ADVISORY_LOCK_KEY = 728_291_004_417;

function log(message: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${message} ${JSON.stringify(extra)}` : message;
  // eslint-disable-next-line no-console
  console.log(`[migrate] ${line}`);
}

function logError(message: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${message} ${JSON.stringify(extra)}` : message;
  // eslint-disable-next-line no-console
  console.error(`[migrate] ${line}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logError("DATABASE_URL is required and was not set");
    process.exit(1);
    return;
  }

  // Default assumes this compiled file lives at apps/api/dist/scripts/migrate.js
  // (four levels below the repo root: scripts -> dist -> api -> apps).
  // Docker/CI always set MIGRATIONS_DIR explicitly (see
  // infra/docker-compose.prod.yml and .github/workflows/ci.yml) and
  // never rely on this default; it exists for convenience when running
  // `npm run migrate -w apps/api` locally without setting it.
  const migrationsDir =
    process.env.MIGRATIONS_DIR ?? join(__dirname, "..", "..", "..", "..", "infra", "migrations");

  let filenames: string[];
  try {
    filenames = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
  } catch (err) {
    logError("Could not read migrations directory", { migrationsDir, err: String(err) });
    process.exit(1);
    return;
  }

  if (filenames.length === 0) {
    log("No .sql files found in migrations directory; nothing to do", { migrationsDir });
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    // Serialize against any concurrent migrate run against the same
    // database. Released automatically when this session ends
    // (process exit / client disconnect), and explicitly below on the
    // normal path.
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ filename: string }>("SELECT filename FROM schema_migrations");
    const alreadyApplied = new Set(rows.map((row) => row.filename));

    const pending = filenames.filter((name) => !alreadyApplied.has(name));

    if (pending.length === 0) {
      log(`Database already up to date (${filenames.length} migration(s) previously applied)`);
      return;
    }

    log(`Applying ${pending.length} pending migration(s)`, { pending });

    for (const filename of pending) {
      const sql = readFileSync(join(migrationsDir, filename), "utf8");
      log(`Applying ${filename}`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
        log(`Applied ${filename}`);
      } catch (err) {
        await client.query("ROLLBACK");
        logError(`Migration ${filename} FAILED; stopping (no later migrations were attempted)`, {
          err: err instanceof Error ? err.message : String(err),
        });
        process.exitCode = 1;
        return;
      }
    }

    log(`All migrations applied (${pending.length} new, ${alreadyApplied.size} previously applied)`);
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    } catch {
      // Best-effort -- the lock is session-scoped and releases on
      // disconnect regardless.
    }
    await client.end();
  }
}

main().catch((err) => {
  logError("Unexpected error", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
