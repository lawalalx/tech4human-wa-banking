/**
 * Core Banking API Integration Layer
 * Wraps calls to the bank's core banking system.
 * Replace the mock implementations with real API calls in production.
 */
import "dotenv/config";

const CORE_BANKING_URL = process.env.CORE_BANKING_API_URL || "https://api.corebanking.example.com/v1";
const CORE_BANKING_KEY = process.env.CORE_BANKING_API_KEY || "";

async function coreRequest<T>(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>
): Promise<{ ok: boolean; data: T | null; error?: string }> {
  try {
    const res = await fetch(`${CORE_BANKING_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": CORE_BANKING_KEY,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      return { ok: false, data: null, error: errText };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, data: null, error: message };
  }
}

// ─── Account ──────────────────────────────────────────────────────────────────

export interface AccountBalance {
  accountNumber: string;
  accountName: string;
  balance: number;
  availableBalance: number;
  currency: string;
  accountType: string;
}

export async function getAccountBalance(
  accountNumber: string
): Promise<AccountBalance | null> {
  // MOCK: Replace with real core banking call
  console.log(`[CoreBanking] getAccountBalance: ${accountNumber}`);
  return {
    accountNumber,
    accountName: "JOHN DOE",
    balance: 250000.0,
    availableBalance: 245000.0,
    currency: "NGN",
    accountType: "SAVINGS",
  };
}

export interface Transaction {
  reference: string;
  date: string;
  description: string;
  amount: number;
  type: "debit" | "credit";
  balance: number;
}

export async function getMiniStatement(
  accountNumber: string,
  limit = 10
): Promise<Transaction[]> {
  console.log(`[CoreBanking] getMiniStatement: ${accountNumber}`);
  // MOCK: Return sample transactions
  return Array.from({ length: limit }, (_, i) => ({
    reference: `REF-${Date.now()}-${i}`,
    date: new Date(Date.now() - i * 86400000).toISOString().split("T")[0],
    description: ["DSTV Payment", "Transfer to Mary", "ATM Withdrawal", "Salary Credit"][i % 4],
    amount: [5000, 20000, 10000, 450000][i % 4],
    type: (i % 4 === 3 ? "credit" : "debit") as "debit" | "credit",
    balance: 250000 + i * 5000,
  }));
}

// ─── Transfers ────────────────────────────────────────────────────────────────

export interface TransferRequest {
  fromAccount: string;
  toAccount: string;
  toBankCode: string;
  amount: number;
  narration: string;
  reference: string;
}

export interface TransferResult {
  success: boolean;
  reference: string;
  sessionId?: string;
  message: string;
}

export async function executeIntraTransfer(req: TransferRequest): Promise<TransferResult> {
  console.log(`[CoreBanking] executeIntraTransfer:`, req);
  // MOCK: Simulate successful transfer
  return {
    success: true,
    reference: req.reference,
    sessionId: `SES-${Date.now()}`,
    message: "Transfer successful",
  };
}

export async function executeInterBankTransfer(req: TransferRequest): Promise<TransferResult> {
  console.log(`[CoreBanking] executeInterBankTransfer:`, req);
  return {
    success: true,
    reference: req.reference,
    sessionId: `SES-${Date.now()}`,
    message: "Interbank transfer successful",
  };
}

export async function verifyAccountName(
  accountNumber: string,
  bankCode: string
): Promise<{ name: string | null; error?: string }> {
  console.log(`[CoreBanking] verifyAccountName: ${accountNumber} @ ${bankCode}`);
  // MOCK: Return a sample name
  return { name: "JANE SMITH" };
}

// ─── Bill Payment ─────────────────────────────────────────────────────────────

export interface BillPaymentRequest {
  billerCode: string;
  customerId: string;
  amount: number;
  fromAccount: string;
  reference: string;
}

export interface BillPaymentResult {
  success: boolean;
  reference: string;
  receiptNumber?: string;
  message: string;
}

export async function executeBillPayment(req: BillPaymentRequest): Promise<BillPaymentResult> {
  console.log(`[CoreBanking] executeBillPayment:`, req);
  return {
    success: true,
    reference: req.reference,
    receiptNumber: `RCP-${Date.now()}`,
    message: "Bill payment successful",
  };
}

export async function validateBiller(
  billerCode: string,
  customerId: string
): Promise<{ valid: boolean; customerName?: string; amount?: number }> {
  console.log(`[CoreBanking] validateBiller: ${billerCode}, ${customerId}`);
  return { valid: true, customerName: "John Doe", amount: 7500 };
}

// ─── Transaction Spending ─────────────────────────────────────────────────────

export interface SpendingCategory {
  category: string;
  total: number;
  percentage: number;
  transactions: number;
}

export async function getSpendingSummary(
  accountNumber: string,
  fromDate: string,
  toDate: string
): Promise<{ categories: SpendingCategory[]; totalSpent: number; totalIncome: number }> {
  console.log(`[CoreBanking] getSpendingSummary: ${accountNumber} ${fromDate}–${toDate}`);
  return {
    totalSpent: 196000,
    totalIncome: 450000,
    categories: [
      { category: "Groceries & Food", total: 45000, percentage: 23, transactions: 12 },
      { category: "Transport & Fuel", total: 32000, percentage: 16, transactions: 8 },
      { category: "Utilities & Bills", total: 28500, percentage: 14, transactions: 5 },
      { category: "Entertainment", total: 15000, percentage: 8, transactions: 3 },
      { category: "Other", total: 75500, percentage: 39, transactions: 22 },
    ],
  };
}

// ─── Credit Score ─────────────────────────────────────────────────────────────

export interface CreditScore {
  score: number;
  rating: string;
  lastUpdated: string;
  trend: { month: string; score: number }[];
}

export async function getCreditScore(phone: string): Promise<CreditScore | null> {
  console.log(`[CoreBanking] getCreditScore: ${phone}`);
  return {
    score: 710,
    rating: "Good",
    lastUpdated: new Date().toISOString().split("T")[0],
    trend: Array.from({ length: 6 }, (_, i) => ({
      month: new Date(Date.now() - i * 30 * 86400000).toLocaleString("default", {
        month: "short",
        year: "numeric",
      }),
      score: 700 + i * 2,
    })).reverse(),
  };
}
