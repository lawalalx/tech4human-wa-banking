import "dotenv/config";
import { PgVector } from "@mastra/pg";
import { BANK_ID } from "./db.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

/**
 * Singleton PgVector store for this deployment.
 * Multi-tenant: the index name is namespaced by BANK_ID so each bank's
 * knowledge base is fully isolated in the same PostgreSQL cluster.
 *
 * Index naming: banking_kb_<bank_id>  (e.g. banking_kb_fbn, banking_kb_gtb)
 */
export const vectorStore = new PgVector({
  id: `banking-vector-${BANK_ID}`,
  connectionString: process.env.DATABASE_URL,
});

/**
 * The vector index name for this tenant.
 * Override via VECTOR_INDEX_NAME env var if needed.
 */
export const INDEX_NAME =
  process.env.VECTOR_INDEX_NAME || `banking_kb_${BANK_ID.replace(/-/g, "_")}`;

/**
 * Dimension of the embedding model.
 * text-embedding-3-small → 1536 (default)
 * text-embedding-3-large → 3072
 */
export const EMBEDDING_DIM = parseInt(process.env.PGVECTOR_EMBEDDING_DIM || "1536");

/**
 * Creates the pgvector index if it does not already exist.
 * Safe to call multiple times (idempotent).
 */
export async function initVectorIndex(): Promise<void> {
  try {
    await vectorStore.createIndex({
      indexName: INDEX_NAME,
      dimension: EMBEDDING_DIM,
    });
    console.log(`[RAG] Vector index "${INDEX_NAME}" (dim=${EMBEDDING_DIM}) ready for bank="${BANK_ID}".`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists")) throw err;
    console.log(`[RAG] Vector index "${INDEX_NAME}" already exists for bank="${BANK_ID}".`);
  }
}
