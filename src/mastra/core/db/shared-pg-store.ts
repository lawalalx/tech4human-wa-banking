import "dotenv/config";
import { PostgresStore } from "@mastra/pg";
import { LibSQLStore } from "@mastra/libsql";
import { getDatabaseUrl, isSqliteDatabaseUrl, toLibSqlFileUrl } from "../../../config/database-url.js";

const databaseUrl = getDatabaseUrl();
const sqliteMode = isSqliteDatabaseUrl(databaseUrl);

/**
 * Singleton shared storage adapter used by Mastra.
 * Avoids spinning up multiple connection pools which exhausts memory.
 */
export const sharedPgStore = sqliteMode
  ? new LibSQLStore({
      id: "tech4human-libsql-storage",
      url: toLibSqlFileUrl(databaseUrl),
    })
  : new PostgresStore({
      id: "tech4human-pg-storage",
      connectionString: databaseUrl,
      // Keep pool small for memory efficiency
      max: 5,
    });
