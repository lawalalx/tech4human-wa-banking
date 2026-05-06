import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { callBankingTool } from "../core/mcp/banking-mcp-client.js";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Simple keyword-based category classifier for transaction descriptions
function classifyTransaction(description: string): string {
  const d = (description ?? "").toUpperCase();
  if (/DSTV|GOTV|SHOWMAX|STARTIMES|CINEMA|NETFLIX/.test(d)) return "Entertainment";
  if (/MTN|AIRTEL|GLO|9MOBILE|ETISALAT|AIRTIME|DATA/.test(d)) return "Airtime & Data";
  if (/FOOD|CHICKEN|PIZZA|EATERY|RESTAURANT|CAFE|KITCHEN|CANTEEN/.test(d)) return "Food & Dining";
  if (/EKEDC|IKEDC|AEDC|PHEDC|IBEDC|EEDC|ELECTRIC|NEPA|PHCN|LIGHT/.test(d)) return "Utilities";
  if (/FUEL|PETROL|NNPC|TOTAL|MOBIL|ARDOVA/.test(d)) return "Transport & Fuel";
  if (/UBER|BOLT|TAXI|BRT|RIDE/.test(d)) return "Transport & Fuel";
  if (/HOSPITAL|PHARMACY|CLINIC|HEALTH|MEDIC/.test(d)) return "Healthcare";
  if (/SCHOOL|FEES|UNIVERSITY|COLLEGE|TUITION/.test(d)) return "Education";
  if (/TRANSFER|PAYMENT|DEBIT|CREDIT|TRF/.test(d)) return "Transfers";
  return "Others";
}

// ─── Spending Insights ────────────────────────────────────────────────────────

export const spendingInsightsTool = createTool({
  id: "get-spending-summary",
  description:
    "Retrieve and summarise categorised spending data for a customer over a given period. " +
    "Uses the customer's phone to auto-lookup their account — do NOT ask for account number. " +
    "Pass 'accountNumber' directly if the customer already chose one from a multi-account selection. " +
    "Use for spending insights, savings recommendations, and smart budgeting queries.",
  inputSchema: z.object({
    phone: z.string().optional().describe("Customer's phone number for account lookup"),
    accountNumber: z.string().optional().describe("Pre-resolved account number (skip lookup)"),
    period: z
      .enum(["this_week", "last_week", "this_month", "last_month", "last_3_months"])
      .default("this_month"),
  }),
  outputSchema: z.object({
    period: z.string(),
    totalSpent: z.number(),
    totalIncome: z.number(),
    netSavings: z.number(),
    categories: z.array(
      z.object({
        category: z.string(),
        total: z.number(),
        percentage: z.number(),
        transactions: z.number(),
      })
    ),
    error: z.string().optional(),
  }),
  execute: async ({ phone, accountNumber, period = "this_month" }: { phone?: string; accountNumber?: string; period?: string }) => {
    let resolvedAccount = accountNumber;
    if (!resolvedAccount) {
      if (!phone) return { period, totalSpent: 0, totalIncome: 0, netSavings: 0, categories: [], error: "Provide phone or accountNumber" };
      // Resolve customer account
      const lookup = await callBankingTool<{ found: boolean; customer_id?: number; message?: string }>(
        "lookup_customer_by_phone", { phone_number: phone }
      );
      if (!lookup.found || !lookup.customer_id) {
        return { period, totalSpent: 0, totalIncome: 0, netSavings: 0, categories: [], error: lookup.message ?? "Customer not found" };
      }
      const acct = await callBankingTool<{ success: boolean; account_number?: string; message?: string }>(
        "get_customer_account", { customer_id: lookup.customer_id }
      );
      if (!acct.success || !acct.account_number) {
        return { period, totalSpent: 0, totalIncome: 0, netSavings: 0, categories: [], error: acct.message ?? "No account found" };
      }
      resolvedAccount = acct.account_number;
    }

    // Determine lookback limit based on period
    const limitMap: Record<string, number> = {
      this_week: 20, last_week: 20, this_month: 50, last_month: 50, last_3_months: 150,
    };
    const limit = limitMap[period] ?? 50;

    const hist = await callBankingTool<{ success: boolean; transactions?: any[]; message?: string }>(
      "get_transaction_history", { account_number: resolvedAccount, limit }
    );
    const txns: any[] = hist.transactions ?? [];

    // Filter by period
    const now = new Date();
    const dayMs = 86400000;
    const periodStart: Record<string, Date> = {
      this_week: new Date(now.getTime() - 7 * dayMs),
      last_week: new Date(now.getTime() - 14 * dayMs),
      this_month: new Date(now.getFullYear(), now.getMonth(), 1),
      last_month: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      last_3_months: new Date(now.getTime() - 90 * dayMs),
    };
    const periodEnd: Record<string, Date> = {
      last_week: new Date(now.getTime() - 7 * dayMs),
      last_month: new Date(now.getFullYear(), now.getMonth(), 0),
    };
    const start = periodStart[period] ?? periodStart["this_month"];
    const end = periodEnd[period] ?? now;

    const filtered = txns.filter((t) => {
      const d = new Date(t.date ?? t.created_at ?? t.timestamp ?? 0);
      return d >= start && d <= end;
    });

    // Aggregate
    let totalSpent = 0;
    let totalIncome = 0;
    const catMap: Record<string, { total: number; count: number }> = {};

    for (const t of filtered) {
      const amt: number = Number(t.amount) || 0;
      const isDebit = (t.type ?? "").toLowerCase().includes("debit") || amt < 0;
      if (isDebit) {
        const absAmt = Math.abs(amt);
        totalSpent += absAmt;
        const cat = classifyTransaction(t.description ?? t.narration ?? "");
        if (!catMap[cat]) catMap[cat] = { total: 0, count: 0 };
        catMap[cat].total += absAmt;
        catMap[cat].count += 1;
      } else {
        totalIncome += amt;
      }
    }

    const categories = Object.entries(catMap)
      .map(([category, { total, count }]) => ({
        category,
        total,
        percentage: totalSpent > 0 ? Math.round((total / totalSpent) * 100) : 0,
        transactions: count,
      }))
      .sort((a, b) => b.total - a.total);

    return { period, totalSpent, totalIncome, netSavings: totalIncome - totalSpent, categories };
  },
});

// ─── Credit Score ─────────────────────────────────────────────────────────────

export const creditScoreTool = createTool({
  id: "get-credit-score",
  description:
    "Retrieve a customer's estimated credit health based on their recent transaction patterns. " +
    "Uses transaction history from MCP to derive a local credit indicator.",
  inputSchema: z.object({
    phone: z.string(),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    score: z.number().optional(),
    rating: z.string().optional(),
    ratingEmoji: z.string().optional(),
    lastUpdated: z.string().optional(),
    improvementTips: z.array(z.string()),
    error: z.string().optional(),
  }),
  execute: async ({ phone }: { phone: string }) => {
    // Resolve customer
    const lookup = await callBankingTool<{ found: boolean; customer_id?: number; message?: string }>(
      "lookup_customer_by_phone", { phone_number: phone }
    );
    if (!lookup.found || !lookup.customer_id) {
      return { found: false, improvementTips: [], error: lookup.message ?? "Customer not found" };
    }
    const acct = await callBankingTool<{ success: boolean; account_number?: string; message?: string }>(
      "get_customer_account", { customer_id: lookup.customer_id }
    );
    if (!acct.success || !acct.account_number) {
      return { found: false, improvementTips: [], error: acct.message ?? "No account found" };
    }
    const hist = await callBankingTool<{ success: boolean; transactions?: any[] }>(
      "get_transaction_history", { account_number: acct.account_number, limit: 50 }
    );
    const txns: any[] = hist.transactions ?? [];

    // Derive a simple score from transaction pattern
    const credits = txns.filter((t) => !(t.type ?? "").toLowerCase().includes("debit"));
    const debits = txns.filter((t) => (t.type ?? "").toLowerCase().includes("debit"));
    const totalCredit = credits.reduce((s: number, t: any) => s + Math.abs(Number(t.amount) || 0), 0);
    const totalDebit = debits.reduce((s: number, t: any) => s + Math.abs(Number(t.amount) || 0), 0);

    // Ratio of credit inflows vs total activity gives a rough health indicator
    let score = 600;
    if (txns.length > 0) {
      const ratio = totalCredit / (totalCredit + totalDebit + 1);
      score = Math.round(300 + ratio * 550); // 300–850 scale
    }
    let rating: string;
    let ratingEmoji: string;
    if (score >= 750) { rating = "Excellent"; ratingEmoji = "🌟"; }
    else if (score >= 670) { rating = "Good"; ratingEmoji = "✅"; }
    else if (score >= 580) { rating = "Fair"; ratingEmoji = "⚠️"; }
    else { rating = "Needs Improvement"; ratingEmoji = "❌"; }

    const tips: Record<string, string[]> = {
      Excellent: [
        "Maintain your payment streak — keep all bills current",
        "Keep credit utilisation below 10% for maximum score benefit",
      ],
      Good: [
        "Pay all bills on time — set up auto-debit for recurring payments",
        "Reduce outstanding debt systematically",
      ],
      Fair: [
        "Pay all overdue balances immediately",
        "Set up standing orders for minimum payments",
        "Reduce outstanding debt systematically",
      ],
      "Needs Improvement": [
        "Address all outstanding debts with payment plans",
        "Set up automatic bill payments to avoid future late payments",
        "Review your credit report for any errors",
      ],
    };

    return {
      found: true,
      score,
      rating,
      ratingEmoji,
      lastUpdated: new Date().toISOString().split("T")[0],
      improvementTips: tips[rating] ?? tips["Good"],
    };
  },
});

// ─── Budget Management ────────────────────────────────────────────────────────

export const setBudgetTool = createTool({
  id: "set-budget",
  description:
    "Set or update a monthly spending budget for a specific category. " +
    "Alerts will be sent automatically when 80% of the budget is reached.",
  inputSchema: z.object({
    phone: z.string(),
    accountNumber: z.string(),
    category: z.string().describe("Spending category e.g. 'Groceries & Food'"),
    monthlyLimit: z.number().describe("Monthly budget limit in NGN"),
  }),
  outputSchema: z.object({
    saved: z.boolean(),
    category: z.string(),
    monthlyLimit: z.number(),
    message: z.string(),
  }),
  execute: async ({
    phone,
    accountNumber,
    category,
    monthlyLimit,
  }: {
    phone: string;
    accountNumber: string;
    category: string;
    monthlyLimit: number;
  }) => {
    // Store budget in customer session context
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE customer_sessions
         SET context = jsonb_set(
           COALESCE(context, '{}'),
           '{budgets}',
           COALESCE(context->'budgets', '{}') || $1::jsonb
         ), updated_at = NOW()
         WHERE phone = $2`,
        [JSON.stringify({ [category]: monthlyLimit }), phone]
      );
      return {
        saved: true,
        category,
        monthlyLimit,
        message: `✅ Budget set: ₦${monthlyLimit.toLocaleString()} per month for ${category}.`,
      };
    } catch {
      return {
        saved: false,
        category,
        monthlyLimit,
        message: "Failed to save budget. Please try again.",
      };
    } finally {
      client.release();
    }
  },
});
