import { embed } from "ai";
import { MastraAgentRelevanceScorer, rerankWithScorer } from "@mastra/rag";
import { vectorStore, INDEX_NAME } from "./vector-store.js";
import { getChatModel, getEmbeddingModel } from "../llm/provider.js";
import { BANK_ID } from "./db.js";

export type RetrievedChunk = {
  text: string;
  score: number;
  docId: string;
  filename: string;
  category: string;
  chunkIndex: number;
};

/**
 * Retrieves the most relevant knowledge-base passages for a query.
 *
 * Multi-tenant: results are always filtered to the current bank's documents
 * via the `bankId` metadata filter on the vector store.
 *
 * Pipeline:
 *   1. Embed the query
 *   2. Vector similarity search (topK * 2 initial candidates)
 *   3. Rerank with Mastra's relevance scorer for precision
 *
 * @param query    The customer's question (or a refined version)
 * @param topK     Number of results to return after reranking (default 5)
 * @param category Optional category filter ('faq'|'product'|'policy'|'compliance'|etc.)
 * @param bankId   Override tenant — defaults to BANK_ID env var
 */
export async function retrieveContext(
  query: string,
  topK = 5,
  category?: string,
  bankId = BANK_ID
): Promise<RetrievedChunk[]> {
  // 1. Embed query
  const { embedding } = await embed({
    model: getEmbeddingModel(),
    value: query,
  });

  // 2. Build filter — always restrict to current bank
  const filterObj: Record<string, unknown> = { bankId };
  if (category) filterObj.category = category;

  // 3. Vector search — fetch more than needed for reranking
  const initialResults = await vectorStore.query({
    indexName: INDEX_NAME,
    queryVector: embedding,
    topK: topK * 2,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter: filterObj as any,
  });

  if (!initialResults.length) return [];

  // 4. Rerank for semantic relevance
  const relevanceScorer = new MastraAgentRelevanceScorer(
    "banking-kb-relevance-scorer",
    getChatModel() as any
  );

  const reranked = await rerankWithScorer({
    results: initialResults,
    query,
    scorer: relevanceScorer,
    options: {
      weights: { semantic: 0.5, vector: 0.3, position: 0.2 },
      topK,
    },
  });

  // 5. Normalise into a clean typed array
  return reranked.map((r: any) => {
    const meta = r.result?.metadata ?? r.metadata ?? {};
    return {
      text: meta.text ?? "",
      score: r.score ?? r.result?.score ?? 0,
      docId: meta.docId ?? "",
      filename: meta.filename ?? "",
      category: meta.category ?? "general",
      chunkIndex: meta.chunkIndex ?? 0,
    };
  }).filter((c) => c.text.length > 0);
}

/**
 * Quick relevance check — returns true if at least one result scores above threshold.
 * Useful for the agent to decide whether to answer from KB or escalate.
 */
export async function hasRelevantContext(
  query: string,
  threshold = 0.6,
  bankId = BANK_ID
): Promise<boolean> {
  const results = await retrieveContext(query, 1, undefined, bankId);
  return results.length > 0 && results[0].score >= threshold;
}
