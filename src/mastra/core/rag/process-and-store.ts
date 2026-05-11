import crypto from "crypto";
import { MDocument } from "@mastra/rag";
import { embedMany } from "ai";
import { vectorStore, INDEX_NAME } from "./vector-store.js";
import { extractText } from "./ingest-files.js";
import { getEmbeddingModel } from "../llm/provider.js";
import { BANK_ID } from "./db.js";

type ProcessInput = {
  filePath: string;
  docId: string;
  originalName: string;
  /** Optional category tag stored in vector metadata for filtered retrieval */
  category?: string;
  /** Bank ID override — defaults to BANK_ID env var */
  bankId?: string;
};

type ProcessResult = {
  success: boolean;
  docId: string;
  filename: string;
  totalChunks: number;
  bankId: string;
};

/**
 * Full RAG ingestion pipeline:
 *   1. Extract text from uploaded file
 *   2. Remove any previously stored chunks for this docId (idempotent re-index)
 *   3. Chunk text with overlap
 *   4. Embed all chunks (batch call)
 *   5. Upsert vectors with rich metadata (including bank_id for multi-tenant filtering)
 */
export async function processAndStore(input: ProcessInput): Promise<ProcessResult> {
  const { filePath, docId, originalName } = input;
  const bankId = input.bankId ?? BANK_ID;
  const category = input.category ?? "general";

  // 1. Extract text
  const text = await extractText(filePath, originalName);
  if (!text?.trim()) throw new Error("Empty document — nothing to index");

  // 2. Build base metadata (stored alongside every vector chunk)
  const baseMetadata = {
    docId,
    bankId,                   // ← tenant isolation key
    category,
    filename: originalName,
    contentHash: crypto.createHash("sha256").update(text).digest("hex"),
    createdAt: new Date().toISOString(),
    source: "upload",
  };

  // 3. Remove previous vectors for this docId (safe idempotent re-index on re-upload)
  await safeDeleteByDocId(docId, bankId);

  console.log("[RAG] Generating chunks...");
  console.time("chunking");

  // 4. Chunk — recursive strategy preserves sentence boundaries
  const doc = MDocument.fromText(text);
  const chunks = await doc.chunk({
    strategy: "recursive",
    maxSize: 512,
    overlap: 64,
  });
  if (!chunks.length) throw new Error("Chunking produced no content");
  console.timeEnd("chunking");
  console.log(`[RAG] chunks generated: ${chunks.length}`);

  const BATCH_SIZE = 50;
    const allEmbeddings: number[][] = [];
    console.log(`[RAG] embedding ${chunks.length} chunks in batches of ${BATCH_SIZE}`);
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE).map((c) => c.text);
      console.log(`[RAG] embedding batch ${i}-${i + batch.length - 1}`);
      console.time(`embed-batch-${i}`);
      const { embeddings } = await embedMany({
        model: getEmbeddingModel(),
        values: batch,
      });
      console.timeEnd(`embed-batch-${i}`);
      if (!embeddings || embeddings.length !== batch.length) {
        console.warn(`[RAG] Unexpected embeddings length: got ${embeddings?.length}, expected ${batch.length}`);
      }
      allEmbeddings.push(...embeddings);
    }

  
  console.time("upsert");
  // 6. Upsert vectors — each chunk carries its text in metadata for retrieval
  await vectorStore.upsert({
    indexName: INDEX_NAME,
    vectors: allEmbeddings,
    metadata: chunks.map((chunk, i) => ({
      ...baseMetadata,
      text: chunk.text,               // ← retrieved and surfaced to the agent
      chunkIndex: i,
      chunkId: chunk.id_ ?? `${docId}_${i}`,
    })),
  });

  console.timeEnd("upsert");
  console.log("[RAG] Upsert complete");

  console.log(
    `[RAG] Indexed doc="${originalName}" docId=${docId} bank="${bankId}" chunks=${chunks.length}`
  );


  return {
    success: true,
    docId,
    filename: originalName,
    totalChunks: chunks.length,
    bankId,
  };
}

/**
 * Removes ALL vector chunks belonging to a specific docId + bankId combination.
 * Silently skips if the index does not yet exist.
 */
export async function safeDeleteByDocId(docId: string, bankId = BANK_ID): Promise<void> {
  try {
    await vectorStore.deleteVectors({
      indexName: INDEX_NAME,
      filter: { docId, bankId },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("does not exist")) throw err;
    console.log(`[RAG] Skipping delete — index not yet created.`);
  }
}
