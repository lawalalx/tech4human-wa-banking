import "dotenv/config";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema.js";
import { fileURLToPath } from "url";

// Shared advisory lock key for schema migrations in this service.
const MIGRATION_LOCK_KEY = 70432001;

export async function runMigrations() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log("Running database migrations...");

    // Prevent concurrent migration runs from multiple node processes.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(SCHEMA_SQL);

    console.log("✅ Migrations completed successfully.");
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } catch {
      // Ignore unlock failures; releasing the connection also releases session locks.
    }
    client.release();
    await pool.end();
  }
}

// Only auto-run when executed directly via `tsx src/db/migrate.ts`
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runMigrations().catch((err) => {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  });
}
