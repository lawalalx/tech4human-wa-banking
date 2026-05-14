import "dotenv/config";

const SQLITE_URL_PREFIXES = ["sqlite://", "sqlite+aiosqlite://", "file:", "libsql:"];

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return url;
}

export function isSqliteDatabaseUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return SQLITE_URL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function stripSqliteScheme(url: string): string {
  return url
    .replace(/^sqlite\+aiosqlite:\/\//i, "")
    .replace(/^sqlite:\/\//i, "")
    .replace(/^file:/i, "")
    .replace(/^libsql:/i, "");
}

export function toLibSqlFileUrl(url: string): string {
  if (url.startsWith("libsql:") || url.startsWith("file:")) {
    return url;
  }

  const rawPath = stripSqliteScheme(url);
  // SQLAlchemy style: sqlite:///firstbank.db should map to file:./firstbank.db
  if (rawPath.startsWith("/") && !rawPath.match(/^\/[A-Za-z]:\//)) {
    return `file:.${rawPath}`;
  }

  return `file:${rawPath}`;
}
