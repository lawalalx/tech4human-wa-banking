/**
 * Contextual (LLM) intent classification for customer responses.
 *
 * Customers phrase things any way they like ("all set", "we good", "that's all,
 * I've finished filling it"), so brittle anchored regexes are replaced with a
 * small, cached LLM classification call. Follows the established project
 * pattern from services/personal-memory.ts (AI SDK generateText + strict-JSON
 * prompt + graceful fallback).
 *
 * NOTE: format-validation regexes (4-digit PIN, account numbers, OTP codes)
 * and markup parsing (<flow_action>, <options>) are NOT intent matching and
 * remain regex-based by design.
 */
import { generateText } from "ai";
import { getChatModel } from "../mastra/core/llm/provider.js";

// ─── Result cache (identical short texts repeat constantly: "Done", "Balance") ──
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: unknown; expires: number }>();

function cacheGet<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown): void {
  // Simple size guard — classification texts are tiny, 500 entries is plenty.
  if (cache.size >= 500) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/** Extract the first JSON object from an LLM reply (parsing OUR model output). */
function extractJSON(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Core: one cheap LLM call with a strict-JSON prompt, cached, with a
 * keyword-list fallback so the bot never blocks if the LLM hiccups.
 * The fallback uses broad substring matching on a normalized text — far more
 * permissive than anchored regexes — and is only a degraded mode.
 */
async function llmClassify<T>(params: {
  purpose: string;
  system: string;
  text: string;
  validate: (v: Record<string, unknown>) => T | null;
  fallback: (normalized: string) => T;
}): Promise<T> {
  const normalized = String(params.text || "").toLowerCase().trim();
  const key = `${params.purpose}::${normalized}`;
  const cached = cacheGet<T>(key);
  if (cached !== null) return cached;

  try {
    const result = await generateText({
      model: getChatModel(),
      prompt:
        `${params.system}\n` +
        `Return ONLY compact JSON. No markdown, no prose, JSON only.\n\n` +
        `Customer message: ${params.text}`,
    });
    const parsed = extractJSON(result.text || "");
    const validated = parsed ? params.validate(parsed) : null;
    if (validated !== null) {
      cacheSet(key, validated);
      return validated;
    }
  } catch {
    // LLM unreachable/slow — degrade to the keyword fallback below.
  }
  return params.fallback(normalized);
}

// ─── 1. Flow-completion confirmation ("Done", "all set", "that's all", …) ────

const FLOW_DONE_WORDS = [
  "done", "finished", "complete", "completed", "linked", "all set",
  "submitted", "filled", "ok", "okay", "sorted", "through with",
];

/**
 * Does this customer message mean they consider the form/flow finished?
 * LLM-based (contextual), cached, with a broad keyword fallback.
 */
export async function isFlowDonePhrase(text: string): Promise<boolean> {
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed === "__FLOW_COMPLETED__") return trimmed === "__FLOW_COMPLETED__";
  // Only short acknowledgements qualify — a sentence with a new request does not.
  if (trimmed.length > 80) return false;

  return llmClassify<boolean>({
    purpose: "flow_done",
    system:
      "A bank customer on WhatsApp just completed a form/flow (account linking or PIN setup). " +
      "Decide whether their message merely acknowledges that they finished the form/flow, with NO new banking request inside it. " +
      'Examples that mean done: "Done", "OK done", "I have finished", "all set", "that is all", "we good", "sorted", "I have linked it". ' +
      'Examples that mean NOT done: "Check my balance", "Transfer 5000", "what is my account number", "help". ' +
      'Answer as {"done": true} or {"done": false}.',
    text: trimmed,
    validate: (v) => (typeof v.done === "boolean" ? v.done : null),
    fallback: (normalized) => {
      if (normalized.length > 80) return false;
      return FLOW_DONE_WORDS.some((w) => normalized.includes(w));
    },
  });
}

// ─── 2. Banking intent → sub-agent routing ───────────────────────────────────

/** agentId or null (null = leave routing to the supervisor). */
export type BankingAgentId =
  | "balanceAgent"
  | "transferAgent"
  | "transactionHistoryAgent"
  | "insightsAgent"
  | "securityAgent"
  | "supportAgent";

const AGENT_WORDS: Array<[BankingAgentId, string[]]> = [
  ["balanceAgent", ["balance", "how much"]],
  ["transferAgent", ["transfer", "send money", "send", "pay", "wire", "remit"]],
  ["transactionHistoryAgent", ["statement", "history", "transaction"]],
  ["insightsAgent", ["spending", "insight", "budget", "credit score"]],
  ["securityAgent", ["pin", "card", "fraud", "block", "device"]],
  ["supportAgent", ["help", "agent", "complaint", "support", "customer care"]],
];

/**
 * Which specialised sub-agent should handle this customer text?
 * Returns null for greetings/ambiguity so the bankingSupervisor stays in
 * charge. LLM-based (contextual), cached, with a broad keyword fallback.
 */
export async function classifyBankingIntent(text: string): Promise<BankingAgentId | null> {
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed.startsWith("__")) return null;
  if (trimmed.length > 200) return null; // free-form long text → supervisor

  return llmClassify<BankingAgentId | null>({
    purpose: "banking_intent",
    system:
      "Classify this WhatsApp banking customer message into ONE intent. " +
      'Answer as {"intent": "<value>"} where <value> is exactly one of: ' +
      '"balance" (check account balance), ' +
      '"transfer" (send money / pay someone / bills), ' +
      '"statement" (transaction history or mini statement), ' +
      '"insights" (spending analysis, budgeting, credit score), ' +
      '"security" (PIN management, card, fraud, devices), ' +
      '"support" (help, complaints, human agent), ' +
      '"other" (greetings, thanks, anything else). ' +
      "Judge meaning, not keywords — e.g. \"what do I have left\" is balance, \"move 5k to mum\" is transfer.",
    text: trimmed,
    validate: (v) => {
      const intent = String(v.intent || "").toLowerCase();
      const map: Record<string, BankingAgentId> = {
        balance: "balanceAgent",
        transfer: "transferAgent",
        statement: "transactionHistoryAgent",
        history: "transactionHistoryAgent",
        insights: "insightsAgent",
        security: "securityAgent",
        support: "supportAgent",
      };
      return map[intent] ?? null;
    },
    fallback: (normalized) => {
      for (const [agentId, words] of AGENT_WORDS) {
        if (words.some((w) => normalized.includes(w))) return agentId;
      }
      return null;
    },
  });
}

// ─── 3. Insights-workflow intent ──────────────────────────────────────────────

export type InsightsIntent = "spending" | "chart" | "credit_score" | "set_budget" | "unknown";

const INSIGHTS_WORDS: Array<[InsightsIntent, string[]]> = [
  ["credit_score", ["credit score", "credit health", "credit rating"]],
  ["set_budget", ["set budget", "budget for", "budget limit", "monthly budget"]],
  ["chart", ["chart", "graph", "visual", "trend"]],
  ["spending", ["spending", "insight", "savings", "where my money"]],
];

/**
 * Which insights capability does this customer message need?
 * LLM-based (contextual), cached, with a broad keyword fallback.
 */
export async function classifyInsightsIntent(text: string): Promise<InsightsIntent> {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "unknown";

  return llmClassify<InsightsIntent>({
    purpose: "insights_intent",
    system:
      "Classify this WhatsApp message into ONE financial-insights intent. " +
      'Answer as {"intent": "<value>"} where <value> is exactly one of: ' +
      '"credit_score" (asking about their credit score/rating), ' +
      '"set_budget" (asking to set/create a budget with a limit), ' +
      '"chart" (asking for a chart, graph or visual of spending), ' +
      '"spending" (asking for spending analysis/insights/breakdown), ' +
      '"unknown" (anything else). ' +
      "Judge meaning, not keywords — e.g. \"how am I doing with money this month\" is spending.",
    text: trimmed,
    validate: (v) => {
      const intent = String(v.intent || "").toLowerCase();
      const allowed: InsightsIntent[] = ["spending", "chart", "credit_score", "set_budget", "unknown"];
      return (allowed as string[]).includes(intent) ? (intent as InsightsIntent) : null;
    },
    fallback: (normalized) => {
      for (const [intent, words] of INSIGHTS_WORDS) {
        if (words.some((w) => normalized.includes(w))) return intent;
      }
      return "unknown";
    },
  });
}

