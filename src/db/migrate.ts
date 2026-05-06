import "dotenv/config";
import { Pool } from "pg";
import { SCHEMA_SQL } from "./schema.js";
import { fileURLToPath } from "url";

export async function runMigrations() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log("Running database migrations...");
    await client.query(SCHEMA_SQL);
    console.log("✅ Migrations completed successfully.");
  } finally {
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
