import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { retrieveContext } from "../core/rag/retrieve.js";

const bankName = process.env.BANK_NAME || "First Bank Nigeria";

/**
 * Knowledge Base Search Tool
 *
 * Enables agents to query the bank's document knowledge base (FAQs, product guides,
 * policies, fee schedules, compliance docs) using semantic vector search + reranking.
 *
 * Multi-tenant: automatically scoped to the current bank via BANK_ID env var.
 * Each bank deployment has its own isolated vector index.
 *
 * Usage guidance:
 *   - ALWAYS call this BEFORE answering questions about products, fees, procedures,
 *     account types, loan products, card types, branch details, or any banking topic.
 *   - Pass the customer's exact question as the query for best results.
 *   - Use the `category` filter when the intent is specific (e.g., "fee_schedule" for fees).
 *   - If `found = false`, do NOT fabricate an answer — escalate to a human agent.
 */
export const knowledgeBaseTool = createTool({
  id: "knowledge-base-search",
  description:
    `Search the ${bankName} knowledge base for customer FAQs, product info, fee schedules, ` +
    `policies, and compliance documents. ` +
    `ALWAYS call this tool before answering any question about banking products, services, ` +
    `fees, processes, eligibility, limits, or procedures. ` +
    `Use the customer's exact question as the query for best relevance.`,

  inputSchema: z.object({
    query: z
      .string()
      .describe("The customer's question or a precise, refined version of it."),
    category: z
      .enum([
        "faq",
        "product",
        "policy",
        "compliance",
        "fee_schedule",
        "general",
      ])
      .optional()
      .describe(
        "Optional category filter to narrow results. " +
          "'faq' for common questions, 'fee_schedule' for charges, " +
          "'product' for account/loan/card details, 'policy' for terms, " +
          "'compliance' for regulatory docs."
      ),
    topK: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .optional()
      .describe("Number of results to retrieve. Default 5."),
  }),

  outputSchema: z.object({
    found: z.boolean().describe("Whether relevant knowledge-base content was found"),
    topResult: z
      .string()
      .describe("The single most relevant passage, or empty string if none found"),
    allResults: z
      .array(
        z.object({
          text: z.string(),
          score: z.number(),
          filename: z.string(),
          category: z.string(),
        })
      )
      .describe("All retrieved passages ordered by relevance score"),
    suggestion: z
      .string()
      .describe("Guidance for the agent: how to use these results"),
  }),

  execute: async ({
    query,
    category,
    topK = 5,
  }: {
    query: string;
    category?: string;
    topK?: number;
  }) => {
    console.log(
      `[KnowledgeBaseTool] Query="${query}" category=${category ?? "all"} topK=${topK}`
    );

    try {
      const results = await retrieveContext(
        query,
        topK,
        category,
        process.env.BANK_ID || "default"
      );

      const allResults = results.map((r) => ({
        text: r.text,
        score: r.score,
        filename: r.filename,
        category: r.category,
      }));

      const topResult = allResults[0]?.text ?? "";
      const found = allResults.length > 0;

      const suggestion = found
        ? `Found ${allResults.length} relevant passage(s). ` +
          `Use the top result to answer the customer accurately. ` +
          `Cite the document name ("${allResults[0].filename}") if the customer asks for a source. ` +
          `If the passage does not fully answer the question, combine results or escalate.`
        : `No relevant content found in the knowledge base for this query. ` +
          `Do NOT guess or fabricate an answer. ` +
          `Options: (1) rephrase the query and try again, ` +
          `(2) acknowledge you don't have that information and create an escalation ticket, ` +
          `(3) direct the customer to the support line.`;

      console.log(`[KnowledgeBaseTool] Found=${found} results=${allResults.length}`);

      return { found, topResult, allResults, suggestion };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "KB search failed";
      console.error(`[KnowledgeBaseTool] Error:`, err);
      // Return graceful degradation — don't crash the agent
      return {
        found: false,
        topResult: "",
        allResults: [],
        suggestion: `Knowledge base search failed (${msg}). Proceed without KB context or escalate.`,
      };
    }
  },
});
