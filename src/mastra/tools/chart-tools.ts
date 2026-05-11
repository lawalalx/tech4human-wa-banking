/**
 * Transaction Chart Tool — TypeScript/Node.js implementation
 *
 * Renders transaction history and spending analytics charts for WhatsApp delivery.
 * Uses QuickChart.io (https://quickchart.io) — a hosted Chart.js rendering service.
 * No native canvas bindings required; returns a public PNG URL ready for WhatsApp.
 *
 * Supported chart types:
 *   bar   — transaction amounts over time (recent history view)
 *   pie   — spending by category (category breakdown view)
 *   line  — spending trend over time (smooth trend view)
 *
 * Mirrors the Python `chart_handler_node` in whatsapp_agent_fb, using:
 *   - The same category classifier logic from insights-tools.ts
 *   - A text fallback insight if chart generation fails
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const QUICKCHART_BASE = process.env.QUICKCHART_URL ?? "https://quickchart.io/chart";

// Palette for pie/bar charts
const CHART_COLOURS = [
  "#FF6384",
  "#36A2EB",
  "#FFCE56",
  "#4BC0C0",
  "#9966FF",
  "#FF9F40",
  "#66BB6A",
  "#EF5350",
  "#26C6DA",
  "#AB47BC",
];

// ─── Category Classifier (mirrors insights-tools.ts) ─────────────────────────

function classifyCategory(description: string): string {
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtNaira(amount: number): string {
  return `₦${amount.toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtDate(dateStr: string | undefined): string {
  if (!dateStr) return "N/A";
  try {
    return new Date(dateStr).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  } catch {
    return "N/A";
  }
}

function autoChartType(
  chartType: "bar" | "pie" | "line",
  transactions: Array<{ date?: string }>,
): "bar" | "pie" | "line" {
  if (chartType !== "bar") return chartType;
  // If transactions span multiple days, prefer line for trend
  const uniqueDays = new Set(
    transactions.map((t) => {
      try {
        return new Date(t.date ?? "").toDateString();
      } catch {
        return "";
      }
    }),
  ).size;
  return uniqueDays >= 3 ? "line" : "bar";
}

// ─── Chart Config Builders ────────────────────────────────────────────────────

function buildPieConfig(
  transactions: TxnInput[],
  title: string,
): { config: Record<string, unknown>; summary: string } {
  const categoryMap: Record<string, number> = {};

  for (const txn of transactions) {
    const cat = classifyCategory(txn.description ?? txn.type ?? "");
    const amount = Math.abs(Number(txn.amount) || 0);
    categoryMap[cat] = (categoryMap[cat] ?? 0) + amount;
  }

  const entries = Object.entries(categoryMap).sort((a, b) => b[1] - a[1]);
  const labels = entries.map(([k]) => k);
  const data = entries.map(([, v]) => Math.round(v));
  const total = data.reduce((s, v) => s + v, 0);
  const topCat = labels[0] ?? "Others";

  const config = {
    type: "pie",
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: labels.map((_, i) => CHART_COLOURS[i % CHART_COLOURS.length]),
          borderWidth: 1,
          borderColor: "#fff",
        },
      ],
    },
    options: {
      plugins: {
        title: { display: true, text: title || "Spending by Category", font: { size: 14 } },
        legend: { position: "right" as const },
        datalabels: {
          color: "#fff",
          formatter: (value: number) => `${Math.round((value / total) * 100)}%`,
        },
      },
    },
  };

  const topPct = total > 0 ? Math.round(((categoryMap[topCat] ?? 0) / total) * 100) : 0;
  const topItems = entries
    .slice(0, 3)
    .map(([k, v]) => `${k} (${Math.round((v / total) * 100)}%)`)
    .join(", ");
  const summary =
    `📊 *Spending Breakdown*\n` +
    `Top categories: ${topItems}.\n` +
    `Largest spend: *${topCat}* at ${fmtNaira(categoryMap[topCat] ?? 0)} (${topPct}% of ${fmtNaira(total)}).`;

  return { config, summary };
}

function buildBarConfig(
  transactions: TxnInput[],
  title: string,
): { config: Record<string, unknown>; summary: string } {
  const sorted = [...transactions].sort(
    (a, b) => new Date(a.date ?? 0).getTime() - new Date(b.date ?? 0).getTime(),
  );

  const labels = sorted.map((t, i) => fmtDate(t.date) || `Txn ${i + 1}`);
  const data = sorted.map((t) => Math.abs(Number(t.amount) || 0));
  const total = data.reduce((s, v) => s + v, 0);
  const maxIdx = data.indexOf(Math.max(...data));

  const config = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Amount (₦)",
          data,
          backgroundColor: "rgba(255, 99, 132, 0.75)",
          borderColor: "rgba(255, 99, 132, 1)",
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: title || "Recent Transactions",
          font: { size: 14 },
        },
        legend: { display: false },
      },
      scales: { y: { beginAtZero: true, title: { display: true, text: "Amount (₦)" } } },
    },
  };

  const summary =
    `📊 *Transaction Overview*\n` +
    `${data.length} transactions · Total: *${fmtNaira(total)}*\n` +
    `Largest: *${fmtNaira(data[maxIdx] ?? 0)}* on ${labels[maxIdx] ?? "N/A"}.`;

  return { config, summary };
}

function buildLineConfig(
  transactions: TxnInput[],
  title: string,
): { config: Record<string, unknown>; summary: string } {
  const sorted = [...transactions].sort(
    (a, b) => new Date(a.date ?? 0).getTime() - new Date(b.date ?? 0).getTime(),
  );

  const labels = sorted.map((t, i) => fmtDate(t.date) || `Txn ${i + 1}`);
  const data = sorted.map((t) => Math.abs(Number(t.amount) || 0));
  const total = data.reduce((s, v) => s + v, 0);
  const avg = data.length ? total / data.length : 0;

  const config = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Amount (₦)",
          data,
          fill: true,
          backgroundColor: "rgba(54, 162, 235, 0.15)",
          borderColor: "rgba(54, 162, 235, 1)",
          pointBackgroundColor: "rgba(54, 162, 235, 1)",
          tension: 0.35,
          borderWidth: 2,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: title || "Spending Trend",
          font: { size: 14 },
        },
        legend: { display: false },
      },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: "Amount (₦)" } },
        x: { title: { display: true, text: "Date" } },
      },
    },
  };

  const summary =
    `📈 *Spending Trend*\n` +
    `${data.length} transactions · Total: *${fmtNaira(total)}*\n` +
    `Average per transaction: *${fmtNaira(avg)}*.`;

  return { config, summary };
}

// ─── Tool Input Type ──────────────────────────────────────────────────────────

interface TxnInput {
  date?: string;
  amount: number;
  type?: string;
  description?: string;
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const transactionChartTool = createTool({
  id: "generate-transaction-chart",
  description:
    "Generate a chart image URL for transaction history or spending analytics and return it for WhatsApp. " +
    "Call this when the customer asks to see a chart, trend, or visual breakdown of their transactions. " +
    "Supported chart types: 'bar' (amounts per transaction), 'pie' (spending by category), 'line' (trend over time). " +
    "The tool auto-selects 'line' for bar when transactions span 3+ days. " +
    "Returns a public chartUrl (send via WhatsApp image message) and a text summary.",
  inputSchema: z.object({
    transactions: z
      .array(
        z.object({
          date: z.string().optional(),
          amount: z.number(),
          type: z.string().optional(),
          description: z.string().optional(),
        }),
      )
      .min(1)
      .describe("Transaction array from get-transaction-history or get-spending-summary"),
    chartType: z
      .enum(["bar", "pie", "line"])
      .default("bar")
      .describe("Chart type — bar=per-txn, pie=by-category, line=trend"),
    title: z.string().optional().describe("Optional chart title override"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    chartUrl: z.string().optional().describe("Public QuickChart URL — send as WhatsApp image"),
    summary: z.string().describe("Short text insight about the chart data"),
    error: z.string().optional(),
  }),
  execute: async ({
    transactions,
    chartType = "bar",
    title,
  }: {
    transactions: TxnInput[];
    chartType?: "bar" | "pie" | "line";
    title?: string;
  }) => {
    if (!transactions || transactions.length === 0) {
      return {
        success: false,
        summary: "No transaction data available to chart.",
        error: "Empty transactions array",
      };
    }

    try {
      const resolvedType = autoChartType(chartType, transactions);
      const chartTitle = title ?? (resolvedType === "pie" ? "Spending by Category" : resolvedType === "line" ? "Spending Trend" : "Recent Transactions");

      let chartConfig: Record<string, unknown>;
      let summary: string;

      if (resolvedType === "pie") {
        ({ config: chartConfig, summary } = buildPieConfig(transactions, chartTitle));
      } else if (resolvedType === "line") {
        ({ config: chartConfig, summary } = buildLineConfig(transactions, chartTitle));
      } else {
        ({ config: chartConfig, summary } = buildBarConfig(transactions, chartTitle));
      }

      // QuickChart URL — config is URL-encoded JSON
      // ?w=500&h=300 — WhatsApp-friendly dimensions; bkg=white — clean background
      const configParam = encodeURIComponent(JSON.stringify(chartConfig));
      const chartUrl = `${QUICKCHART_BASE}?c=${configParam}&w=500&h=300&bkg=white&devicePixelRatio=2`;

      return { success: true, chartUrl, summary };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ChartTool] Failed to build chart:", message);
      return {
        success: false,
        summary: "Chart generation encountered an error. Here's a text summary of your transactions.",
        error: message,
      };
    }
  },
});
