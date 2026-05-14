import "dotenv/config";
import { PostgresStore } from "@mastra/pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

/**
 * Singleton PostgresStore shared across all agents and the Mastra instance.
 * Avoids spinning up multiple connection pools which exhausts memory.
 */
export const sharedPgStore = new PostgresStore({
  id: "tech4human-pg-storage",
  connectionString: process.env.DATABASE_URL,
  // Keep pool small for memory efficiency
  max: 5,
});
