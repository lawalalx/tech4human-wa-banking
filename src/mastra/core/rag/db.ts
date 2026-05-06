import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * BANK_ID uniquely identifies this bank deployment.
 * Used to isolate knowledge-base documents per tenant.
 * Set via BANK_ID env var (e.g. "fbn", "gtb", "access").
 */
export const BANK_ID = process.env.BANK_ID || "default";

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * Creates the `kb_docs` table if it does not already exist.
 * Multi-tenant: every row is scoped to a `bank_id`.
 * Safe to call multiple times (idempotent).
 */
export async function createKbDocsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_docs (
      doc_id        UUID         PRIMARY KEY,
      bank_id       VARCHAR(50)  NOT NULL DEFAULT 'default',
      title         TEXT,
      original_name TEXT         NOT NULL,
      file_path     TEXT         NOT NULL,
      category      VARCHAR(50)  DEFAULT 'general',
      -- category: 'faq'|'product'|'policy'|'compliance'|'fee_schedule'|'general'
      language      VARCHAR(10)  DEFAULT 'en',
      size          BIGINT,
      chunk_count   INTEGER,
      uploaded_by   VARCHAR(100),
      uploaded_at   TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kb_docs_bank ON kb_docs(bank_id);
    CREATE INDEX IF NOT EXISTS idx_kb_docs_category ON kb_docs(bank_id, category);
  `);
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export async function insertDoc(params: {
  docId: string;
  bankId?: string;
  title?: string;
  originalName: string;
  filePath: string;
  category?: string;
  language?: string;
  size?: number;
  chunkCount?: number;
  uploadedBy?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO kb_docs
       (doc_id, bank_id, title, original_name, file_path, category, language, size, chunk_count, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (doc_id) DO UPDATE
       SET title        = EXCLUDED.title,
           category     = EXCLUDED.category,
           chunk_count  = EXCLUDED.chunk_count,
           uploaded_at  = NOW()`,
    [
      params.docId,
      params.bankId ?? BANK_ID,
      params.title ?? null,
      params.originalName,
      params.filePath,
      params.category ?? "general",
      params.language ?? "en",
      params.size ?? null,
      params.chunkCount ?? null,
      params.uploadedBy ?? null,
    ]
  );
}

export async function getAllDocs(bankId = BANK_ID) {
  const { rows } = await pool.query(
    `SELECT doc_id, bank_id, title, original_name, category, language, size, chunk_count, uploaded_at
     FROM kb_docs
     WHERE bank_id = $1
     ORDER BY uploaded_at DESC`,
    [bankId]
  );
  return rows;
}

export async function getDocById(docId: string, bankId = BANK_ID) {
  const { rows } = await pool.query(
    `SELECT * FROM kb_docs WHERE doc_id = $1 AND bank_id = $2`,
    [docId, bankId]
  );
  return rows[0] ?? null;
}

export async function deleteDocRecord(docId: string, bankId = BANK_ID): Promise<void> {
  await pool.query(`DELETE FROM kb_docs WHERE doc_id = $1 AND bank_id = $2`, [docId, bankId]);
}

export async function getDocCountByCategory(bankId = BANK_ID) {
  const { rows } = await pool.query(
    `SELECT category, COUNT(*) AS count FROM kb_docs WHERE bank_id = $1 GROUP BY category`,
    [bankId]
  );
  return rows;
}

export default pool;
