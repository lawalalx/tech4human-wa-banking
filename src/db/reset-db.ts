import "dotenv/config";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { fileURLToPath } from "url";

const MIGRATION_LOCK_KEY = 70432001;

export async function resetDb() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log("🗑️ Clearing existing session data and tokens...");

    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    // Truncate tables to delete data while preserving schema structure
    // Adjust table names if your schema uses different identifiers
    await client.query(`
      TRUNCATE TABLE customer_sessions RESTART IDENTITY CASCADE;
    `);

    // If meta_flow_tokens or verified_customers are separate tables:
    await client.query(`
      TRUNCATE TABLE meta_flow_tokens RESTART IDENTITY CASCADE;
    `).catch(() => {});

    await client.query(`
      TRUNCATE TABLE verified_customers RESTART IDENTITY CASCADE;
    `).catch(() => {});
    
    await client.query(`
      TRUNCATE TABLE customer_pins RESTART IDENTITY CASCADE;
    `).catch(() => {});


    console.log("✅ Database tables cleared successfully.");
  } catch (err) {
    console.error("⚠️ Failed to truncate tables directly:", err);
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } catch {}
    client.release();
    await pool.end();
  }

//   // Ensure fresh schema initialization
//   await runMigrations();
}

// Run when executed directly via `npx tsx src/db/reset-db.ts`
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  resetDb().catch((err) => {
    console.error("❌ Reset script failed:", err);
    process.exit(1);
  });
}
