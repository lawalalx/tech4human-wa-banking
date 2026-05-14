import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { creditScoreTool, setBudgetTool, spendingInsightsTool } from "../tools/insights-tools.js";
import { transactionChartTool } from "../tools/chart-tools.js";
import { resolveCustomerAccountTool } from "../tools/transaction-tools.js";

const inputSchema = z.object({
  phone: z.string(),
  message: z.string(),
});

const outputSchema = z.object({
  handled: z.boolean(),
  reply: z.string(),
});

type InsightsIntent = "spending" | "chart" | "credit_score" | "set_budget" | "unknown";

function money(amount: number): string {
  return `₦${amount.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parsePeriod(message: string): "this_week" | "last_week" | "this_month" | "last_month" | "last_3_months" {
  const text = message.toLowerCase();
  if (text.includes("last 3") || text.includes("three month") || text.includes("90 day")) return "last_3_months";
  if (text.includes("last month")) return "last_month";
  if (text.includes("this week")) return "this_week";
  if (text.includes("last week")) return "last_week";
  return "this_month";
}

function parseIntent(message: string): InsightsIntent {
  const text = message.toLowerCase();

  if (/credit\s*score|credit\s*health|credit\s*rating/.test(text)) return "credit_score";
  if (/set\s*(a\s*)?budget|budget\s*for|budget\s*limit|monthly\s*budget/.test(text)) return "set_budget";
  if (/chart|graph|visual|trend|line\s*chart|bar\s*chart|pie\s*chart/.test(text)) return "chart";
  if (/spending|insight|savings|finance\s*analysis|where\s*my\s*money\s*go/.test(text)) return "spending";

  return "unknown";
}

function parseChartType(message: string): "bar" | "pie" | "line" {
  const text = message.toLowerCase();
  if (text.includes("pie")) return "pie";
  if (text.includes("line") || text.includes("trend")) return "line";
  return "bar";
}

function parseBudgetAmount(message: string): number | null {
  const text = message.toLowerCase().replace(/[,_\s]/g, "");
  const m = text.match(/(\d+(?:\.\d+)?)(k|m)?/i);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const suffix = (m[2] || "").toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  return Math.round(base * multiplier);
}

function parseBudgetCategory(message: string): string | null {
  const text = message.trim();
  const explicit = text.match(/(?:for|on)\s+([a-z][a-z\s&-]{1,40}?)(?:\s+to\s+\d|$)/i);
  if (explicit?.[1]) return explicit[1].trim();
  return null;
}

function buildActionableInsights(summary: any): string[] {
  const categories = Array.isArray(summary?.categories) ? summary.categories : [];
  if (!categories.length) {
    return [
      "Track spending with a weekly check-in so unusual expenses are caught early.",
      "Set one category budget first, then tighten gradually over 2-3 months.",
      "Move a fixed amount to savings immediately after your main inflow.",
    ];
  }

  const top = categories[0];
  const second = categories[1];
  const tips: string[] = [];

  tips.push(`Your highest spend is ${top.category} (${top.percentage}% of outflow). Try reducing it by 10-15% this month.`);
  if (second) {
    tips.push(`Your second-highest spend is ${second.category}. Set a cap of about ${money(second.total * 0.9)} next month.`);
  }

  const netSavings = Number(summary?.netSavings || 0);
  if (netSavings > 0) {
    tips.push(`You are currently net positive by ${money(netSavings)}. Automating 20% of this into savings can build consistency.`);
  } else {
    tips.push("Your current period is net negative. Focus first on trimming non-essential categories before setting aggressive savings targets.");
  }

  return tips.slice(0, 3);
}

const executeInsightsStep = createStep({
  id: "execute-insights-step",
  description: "Run deterministic spending, chart, credit-score, and budget flows",
  inputSchema,
  outputSchema,
  execute: async ({ inputData }) => {
    const phone = String(inputData.phone || "").trim();
    const message = String(inputData.message || "").trim();

    if (!phone || !message) {
      return { handled: true, reply: "Please share your request so I can help with your financial insights." };
    }

    const period = parsePeriod(message);
    const intent = parseIntent(message);

    if (intent === "credit_score") {
      const result = await (creditScoreTool as any).execute({ phone });
      if (!result?.found) {
        return { handled: true, reply: result?.error || "I could not retrieve your credit score right now." };
      }

      const tips = Array.isArray(result.improvementTips) ? result.improvementTips.slice(0, 3) : [];
      return {
        handled: true,
        reply:
          `📈 Credit score update\n` +
          `Score: ${result.score ?? "N/A"} ${result.ratingEmoji || ""} (${result.rating || "Unknown"})\n` +
          `Last updated: ${result.lastUpdated || "N/A"}\n\n` +
          `Top improvement actions:\n${tips.map((t: string, i: number) => `${i + 1}. ${t}`).join("\n")}\n\n` +
          `These insights are based solely on your transaction history with First Bank Nigeria and are for your personal guidance only.`,
      };
    }

    if (intent === "set_budget") {
      const amount = parseBudgetAmount(message);
      const category = parseBudgetCategory(message);

      if (!amount || !category) {
        return {
          handled: true,
          reply:
            "To set your budget, share both category and monthly limit. Example: Set budget for food to 120k.",
        };
      }

      const sender = await (resolveCustomerAccountTool as any).execute({ phone });
      if (sender?.status !== "resolved" || !sender?.accountNumber) {
        return {
          handled: true,
          reply: "I could not resolve your debit account right now. Please try again shortly.",
        };
      }

      const saved = await (setBudgetTool as any).execute({
        phone,
        accountNumber: sender.accountNumber,
        category,
        monthlyLimit: amount,
      });

      return {
        handled: true,
        reply:
          `${saved?.message || "Budget saved."}\n` +
          `I will alert you around 80% utilisation so you can stay in control.`,
      };
    }

    if (intent === "spending" || intent === "chart") {
      const summary = await (spendingInsightsTool as any).execute({ phone, period });
      if (summary?.error) {
        return { handled: true, reply: summary.error };
      }

      const categories = Array.isArray(summary?.categories) ? summary.categories : [];
      if (!categories.length) {
        return {
          handled: true,
          reply:
            `No spending data found for ${String(period).replace(/_/g, " ")}.\n` +
            `These insights are based solely on your transaction history with First Bank Nigeria and are for your personal guidance only.`,
        };
      }

      const actions = buildActionableInsights(summary);
      const baseSummary =
        `📊 Spending insights (${String(period).replace(/_/g, " ")})\n` +
        `Total spent: ${money(Number(summary.totalSpent || 0))}\n` +
        `Total income: ${money(Number(summary.totalIncome || 0))}\n` +
        `Net savings: ${money(Number(summary.netSavings || 0))}\n\n` +
        `Top categories:\n${categories
          .slice(0, 4)
          .map((c: any, i: number) => `${i + 1}. ${c.category}: ${money(Number(c.total || 0))} (${c.percentage || 0}%)`)
          .join("\n")}`;

      if (intent === "chart") {
        const chartType = parseChartType(message);
        const chartInput = categories.map((c: any) => ({
          date: new Date().toISOString(),
          amount: Number(c.total || 0),
          description: c.category,
          type: "debit",
        }));

        const chart = await (transactionChartTool as any).execute({
          transactions: chartInput,
          chartType,
          title: "Spending Insights (Plotly-style)",
        });

        const chartPrefix = chart?.success && chart?.chartUrl ? `<chart_url>${chart.chartUrl}</chart_url>\n` : "";

        return {
          handled: true,
          reply:
            `${chartPrefix}${baseSummary}\n\n` +
            `💡 Actionable insights:\n${actions.map((tip, i) => `${i + 1}. ${tip}`).join("\n")}\n\n` +
            `These insights are based solely on your transaction history with First Bank Nigeria and are for your personal guidance only.`,
        };
      }

      return {
        handled: true,
        reply:
          `${baseSummary}\n\n` +
          `💡 Actionable insights:\n${actions.map((tip, i) => `${i + 1}. ${tip}`).join("\n")}\n\n` +
          `Reply with chart, pie, bar, or line if you want a visual view.\n` +
          `These insights are based solely on your transaction history with First Bank Nigeria and are for your personal guidance only.`,
      };
    }

    return {
      handled: true,
      reply: INSIGHTS_UNKNOWN_REPLY,
    };
  },
});

export const insightsWorkflow = createWorkflow({
  id: "insights-workflow",
  description: "Deterministic workflow for spending insights, charts, budgeting, and credit score",
  inputSchema,
  outputSchema,
})
  .then(executeInsightsStep)
  .commit();

export const INSIGHTS_UNKNOWN_REPLY =
  "I can help with spending insights, charts, budget setup, and credit score. Tell me what you want to check.";
