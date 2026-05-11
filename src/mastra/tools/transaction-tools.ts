import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { callBankingTool } from "../core/mcp/banking-mcp-client.js";
import { randomUUID } from "crypto";

// ─── Shared types ─────────────────────────────────────────────────────────────
interface AccountSummary {
  account_number: string;
  account_number_masked: string;
  account_type: string;
}

// ─── resolve-customer-account ─────────────────────────────────────────────────
// Central account resolver used by balance, statement, insights, and transfer
// tools. Handles three cases:
//   1. Phone not registered → ask for their registered number, suggest linking
//   2. Exactly one account  → resolved, proceed
//   3. Multiple accounts    → ask customer which account to use


// create a lookup tool to find the customer's account(s) based on their phone number. This will be used by balance enquiry, mini statement, and transfer tools to resolve the correct account.
export const lookupCustomerByPhoneTool = createTool({
  id: "lookup_customer_by_phone",
  description:
    "Look up the SENDER/CUSTOMER's account(s) based on their WhatsApp phone number. " +
    "ALWAYS use the phone from the system context message ('Customer phone: +234XXXXXXXXXX'). " +
    "NEVER call this with an account number. NEVER ask the customer for their phone. " +
    "Returns whether the phone is registered, the associated customer ID, and whether a transaction PIN is set. " +
    "This tool is used as the first step in all transaction flows to resolve the customer's account and PIN status.",
  inputSchema: z.object({
    phone: z.string().describe("Customer's WhatsApp phone number"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    customerId: z.number().optional(),
    hasPin: z.boolean().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ phone }: { phone: string }) => {
    const result = await callBankingTool<{
      found: boolean;
      customer_id?: number;
      has_pin?: boolean;
      message?: string;
    }>("lookup_customer_by_phone", { phone_number: phone });

    return {
      found: result.found ?? false,
      customerId: result.customer_id,
      hasPin: result.has_pin ?? false,
      message: result.found ? undefined : result.message,
    };
  },
});


// async def lookup_customer_by_account(account_number: str, bank_code: str) -> LookupCustomerByAccountResponse:
// Look up customer destils by accountnumber and bank_code
export const lookupCustomerByAccountTool = createTool({
  id: "lookup-customer-by-account",
  description:
    "Look up RECIPIENT/DESTINATION account details by account number. " +
    "ONLY use this to verify a transfer recipient — NOT for the sender/customer. " +
    "NEVER pass a phone number to this tool — it requires an actual bank account number. " +
    "Returns whether the account exists, the associated account name, bank name, and customer ID. " +
    "This tool is used to verify recipient details before executing interbank transfers.",
  inputSchema: z.object({
    accountNumber: z.string().describe("The destination account number to look up"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    accountName: z.string().optional(),
    customerId: z.number().optional(),
    message: z.string().optional(),
    bankName: z.string().optional(),
  }),
  execute: async ({ accountNumber }: { accountNumber: string }) => {
    const result = await callBankingTool<{
      found: boolean;
      customer_name?: string;
      customer_id?: number;
      message?: string;
      bank_name?: string;
    }>("lookup_customer_by_account", { account_number: accountNumber });

    return {
      found: result.found ?? false,
      accountName: result.customer_name ?? undefined,
      customerId: result.customer_id,
      message: result.found ? undefined : result.message,
      bankName: result.bank_name ?? undefined
    };
  },
});


// )async def generate_receipt(reference: str) -> ReceiptResponse:
// create a tool to generate a transaction receipt based on a transaction reference. This can be used after executing a transfer to provide the customer with a receipt of their transaction.
export const generateReceiptTool = createTool({
  id: "generate-receipt",
  description:
    "Generate a transaction receipt based on a transaction reference. " +
    "Returns the receipt details including amount, date, masked account number, and transaction status. " +
    "This tool is used after executing a transfer to provide the customer with a receipt of their transaction.",
  inputSchema: z.object({
    reference: z.string().describe("The transaction reference for which to generate the receipt"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    receiptText: z.string(),
    message: z.string(),
  }),
  execute: async ({ reference }: { reference: string }) => {
    const result = await callBankingTool<{
      success: boolean;
      receipt_text: string;
      message: string;
    }>("generate_receipt", { reference });

    return {
      success: result.success,
      receiptText: result.receipt_text,
      message: result.message,
    };
  },
});


export const resolveCustomerAccountTool = createTool({
  id: "resolve-customer-account",
  description:
    "Look up the bank account(s) associated with the SENDER's phone number. " +
    "ALWAYS pass the phone from the system context message ('Customer phone: +234XXXXXXXXXX'). " +
    "Call this FIRST before any balance, statement, transfer or insights tool. " +
    "If the phone is not registered, it prompts the agent to advise the customer to link their WhatsApp number. " +
    "If the customer has multiple accounts, it returns all masked accounts so the agent " +
    "can ask which one to use.",
  inputSchema: z.object({
    phone: z.string().describe("Phone number to look up (WhatsApp or registered)"),
  }),
  outputSchema: z.object({
    status: z.enum(["resolved", "multiple_accounts", "not_found"]),
    // resolved: single account ready to use
    accountNumber: z.string().optional(),
    accountType: z.string().optional(),
    customerId: z.number().optional(),
    // multiple_accounts: list to present to customer
    accounts: z
      .array(
        z.object({
          accountNumber: z.string(),
          maskedAccount: z.string(),
          accountType: z.string(),
        })
      )
      .optional(),
    // not_found: message for the agent
    message: z.string().optional(),
    // advice to show when phone is not registered
    linkAdvice: z.string().optional(),
  }),
  execute: async ({ phone }: { phone: string }) => {
    const lookup = await callBankingTool<{
      found: boolean;
      customer_id?: number;
      message?: string;
    }>("lookup_customer_by_phone", { phone_number: phone });

    if (!lookup.found || !lookup.customer_id) {
      return {
        status: "not_found" as const,
        message: "This phone number is not registered with First Bank Nigeria.",
        linkAdvice:
          "Please visit any First Bank branch or use *894# to link your WhatsApp number to your account so future transactions are seamless.",
      };
    }

    // Fetch ALL accounts for this customer
    const accts = await callBankingTool<{
      success: boolean;
      accounts?: AccountSummary[];
      count?: number;
      message?: string;
    }>("get_customer_accounts", { customer_id: lookup.customer_id });

    if (!accts.success || !accts.accounts || accts.accounts.length === 0) {
      return {
        status: "not_found" as const,
        message: accts.message ?? "No accounts found for this customer.",
      };
    }

    if (accts.accounts.length === 1) {
      return {
        status: "resolved" as const,
        accountNumber: accts.accounts[0].account_number,
        accountType: accts.accounts[0].account_type,
        customerId: lookup.customer_id,
      };
    }

    // Multiple accounts — surface all to agent
    return {
      status: "multiple_accounts" as const,
      customerId: lookup.customer_id,
      accounts: accts.accounts.map((a) => ({
        accountNumber: a.account_number,
        maskedAccount: a.account_number_masked,
        accountType: a.account_type,
      })),
      message: `I can see you have ${accts.accounts.length} accounts on this number.`,
    };
  },
});

// ─── Balance Enquiry ──────────────────────────────────────────────────────────

export const balanceEnquiryTool = createTool({
  id: "get-balance",
  description:
    "Retrieve real-time account balance. " +
    "Pass 'phone' to auto-lookup (single account). " +
    "Pass 'accountNumber' directly when the customer has already chosen one from a multi-account selection.",
  inputSchema: z.object({
    phone: z.string().optional().describe("Customer's phone — used to auto-lookup their account"),
    accountNumber: z.string().optional().describe("Pre-resolved account number (skip lookup)"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    maskedAccount: z.string().optional(),
    balance: z.number().optional(),
    currency: z.string().optional(),
    accountType: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ phone, accountNumber }: { phone?: string; accountNumber?: string }) => {
    let resolvedAccount = accountNumber;

    if (!resolvedAccount) {
      if (!phone) return { found: false, error: "Provide phone or accountNumber" };
      const lookup = await callBankingTool<{ found: boolean; customer_id?: number; message?: string }>(
        "lookup_customer_by_phone", { phone_number: phone }
      );
      if (!lookup.found || !lookup.customer_id) {
        return { found: false, error: lookup.message ?? "Customer not found" };
      }
      const acct = await callBankingTool<{ success: boolean; account_number?: string; message?: string }>(
        "get_customer_account", { customer_id: lookup.customer_id }
      );
      if (!acct.success || !acct.account_number) {
        return { found: false, error: acct.message ?? "No account found" };
      }
      resolvedAccount = acct.account_number;
    }

    const bal = await callBankingTool<{ success: boolean; account_number_masked?: string; balance?: number; currency?: string; account_type?: string; message?: string }>(
      "get_account_balance", { account_number: resolvedAccount }
    );
    if (!bal.success) return { found: false, error: bal.message ?? "Balance unavailable" };
    return {
      found: true,
      maskedAccount: bal.account_number_masked,
      balance: bal.balance,
      currency: bal.currency ?? "NGN",
      accountType: bal.account_type,
    };
  },
});

// ─── Mini Statement ───────────────────────────────────────────────────────────

export const miniStatementTool = createTool({
  id: "get-mini-statement",
  description:
    "Retrieve the last N transactions. " +
    "Pass 'phone' to auto-lookup (single account). " +
    "Pass 'accountNumber' directly when the customer has already chosen from a multi-account selection.",
  inputSchema: z.object({
    phone: z.string().optional().describe("Customer's phone number — auto-lookup account"),
    accountNumber: z.string().optional().describe("Pre-resolved account number (skip lookup)"),
    limit: z.number().optional().default(10),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    maskedAccount: z.string().optional(),
    transactions: z.array(
      z.object({
        date: z.string(),
        type: z.string(),
        amount: z.number(),
        currency: z.string(),
        reference: z.string(),
        description: z.string().optional(),
      })
    ).optional(),
    error: z.string().optional(),
  }),
  execute: async ({ phone, accountNumber, limit = 10 }: { phone?: string; accountNumber?: string; limit?: number }) => {
    let resolvedAccount = accountNumber;

    if (!resolvedAccount) {
      if (!phone) return { found: false, error: "Provide phone or accountNumber", transactions: [] };
      const lookup = await callBankingTool<{ found: boolean; customer_id?: number; message?: string }>(
        "lookup_customer_by_phone", { phone_number: phone }
      );
      if (!lookup.found || !lookup.customer_id) {
        return { found: false, error: lookup.message ?? "Customer not found", transactions: [] };
      }
      const acct = await callBankingTool<{ success: boolean; account_number?: string; message?: string }>(
        "get_customer_account", { customer_id: lookup.customer_id }
      );
      if (!acct.success || !acct.account_number) {
        return { found: false, error: acct.message ?? "No account found", transactions: [] };
      }
      resolvedAccount = acct.account_number;
    }

    const hist = await callBankingTool<{ success: boolean; transactions?: any[]; message?: string }>(
      "get_transaction_history", { account_number: resolvedAccount, limit }
    );
    const an = resolvedAccount;
    const masked = an.slice(0, 3) + "****" + an.slice(-4);
    return {
      found: true,
      maskedAccount: masked,
      transactions: hist.transactions ?? [],
    };
  },
});

// ─── Account Name Verification ────────────────────────────────────────────────

export const verifyAccountNameTool = createTool({
  id: "verify-account-name",
  description:
    "Verify the account name for a given account number via MCP lookup. " +
    "Always call this before any interbank transfer to confirm the destination account owner. " +
    "For First Bank accounts use bankCode='000016'.",
  inputSchema: z.object({
    accountNumber: z.string().describe("Destination account number"),
    bankCode: z.string().describe("NIBSS bank code (e.g. '000016' for First Bank)"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    accountName: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ accountNumber, bankCode }: { accountNumber: string; bankCode: string }) => {
    const result = await callBankingTool<{ found: boolean; account_name?: string; message?: string }>(
      "lookup_customer_by_account", { account_number: accountNumber, bank_code: bankCode }
    );
    if (!result.found) return { found: false, error: result.message ?? "Account not found" };
    return { found: true, accountName: result.account_name };
  },
});

// ─── Intra-bank Transfer ──────────────────────────────────────────────────────

export const intraTransferTool = createTool({
  id: "execute-intra-transfer",
  description:
    "Execute a fund transfer to another account within First Bank. " +
    "Only call this AFTER OTP has been verified and customer has confirmed the recipient. " +
    "Returns a transaction reference on success.",
  inputSchema: z.object({
    fromAccount: z.string().describe("Sender's account number"),
    toAccount: z.string().describe("Recipient's First Bank account number"),
    amount: z.number().describe("Amount in NGN"),
    narration: z.string().describe("Transfer narration / description"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    reference: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({
    fromAccount,
    toAccount,
    amount,
    narration,
  }: {
    fromAccount: string;
    toAccount: string;
    amount: number;
    narration: string;
  }) => {
    const txnId = `TXN-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const result = await callBankingTool<{ success: boolean; message?: string; transaction_id?: string; error_code?: string }>(
      "transfer_funds",
      { from_acc: fromAccount, to_acc: toAccount, amount, txn_id: txnId, description: narration }
    );
    return {
      success: result.success,
      reference: result.transaction_id ?? txnId,
      message: result.message ?? (result.success ? "Transfer successful" : "Transfer failed"),
    };
  },
});

// ─── Interbank Transfer ───────────────────────────────────────────────────────

export const interBankTransferTool = createTool({
  id: "execute-interbank-transfer",
  description:
    "Execute a fund transfer to an account in another bank. " +
    "Only call this AFTER OTP has been verified AND the customer has confirmed the recipient name. " +
    "Use verify-account-name first to confirm the destination.",
  inputSchema: z.object({
    fromAccount: z.string().describe("Sender's account number"),
    toAccount: z.string().describe("Recipient's account number at the destination bank"),
    toBankCode: z.string().describe("NIBSS bank code of destination bank"),
    amount: z.number().describe("Amount in NGN"),
    narration: z.string().describe("Transfer narration"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    reference: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({
    fromAccount,
    toAccount,
    toBankCode,
    amount,
    narration,
  }: {
    fromAccount: string;
    toAccount: string;
    toBankCode: string;
    amount: number;
    narration: string;
  }) => {
    const txnId = `IBT-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const result = await callBankingTool<{ success: boolean; message?: string; transaction_id?: string; error_code?: string }>(
      "transfer_funds",
      { from_acc: fromAccount, to_acc: toAccount, amount, txn_id: txnId, receiver_bank_code: toBankCode, description: narration }
    );
    return {
      success: result.success,
      reference: result.transaction_id ?? txnId,
      message: result.message ?? (result.success ? "Transfer successful" : "Transfer failed"),
    };
  },
});

// ─── Bill Payment ─────────────────────────────────────────────────────────────

export const billPaymentTool = createTool({
  id: "execute-bill-payment",
  description:
    "Execute a bill payment (electricity, DSTV/GoTV, airtime, data, etc.) via MCP. " +
    "Only call AFTER OTP verification and customer confirmation.",
  inputSchema: z.object({
    fromAccount: z.string().describe("Customer's debit account number"),
    billerName: z.string().describe("Biller name (e.g. DSTV, EKEDC, MTN)"),
    amount: z.number().describe("Amount in NGN"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    reference: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({
    fromAccount,
    billerName,
    amount,
  }: {
    fromAccount: string;
    billerName: string;
    amount: number;
  }) => {
    const idempotencyKey = `BILL-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    // pay_bills returns a plain string message from the MCP server
    const message = await callBankingTool<string>(
      "pay_bills",
      { account_number: fromAccount, amount, biller: billerName, idempotency_key: idempotencyKey }
    );
    const success = typeof message === "string" && !message.toLowerCase().includes("fail") && !message.toLowerCase().includes("error");
    return {
      success,
      reference: idempotencyKey,
      message: typeof message === "string" ? message : "Bill payment processed",
    };
  },
});

// ─── Validate Biller ──────────────────────────────────────────────────────────
// No dedicated MCP tool for biller validation; use a known-billers allowlist so
// the agent can confirm the biller exists before calling execute-bill-payment.

const KNOWN_BILLERS = ["DSTV", "GOTV", "STARTIMES", "EKEDC", "IKEDC", "AEDC", "PHEDC",
  "IBEDC", "EEDC", "MTN", "AIRTEL", "GLO", "9MOBILE", "SHOWMAX",
  "LAWMA", "LAGOS WATER", "ABUJA WATER"];

export const validateBillerTool = createTool({
  id: "validate-biller",
  description:
    "Check whether a named biller is supported before initiating a bill payment. " +
    "Returns whether the biller is known and recognised.",
  inputSchema: z.object({
    billerName: z.string().describe("The biller name to validate (e.g. DSTV, EKEDC, MTN)"),
  }),
  outputSchema: z.object({
    valid: z.boolean(),
    normalizedName: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ billerName }: { billerName: string }) => {
    const upper = billerName.toUpperCase().trim();
    const match = KNOWN_BILLERS.find((b) => upper.includes(b) || b.includes(upper));
    if (!match) {
      return { valid: false, error: `Biller '${billerName}' is not in the supported billers list.` };
    }
    return { valid: true, normalizedName: match };
  },
});
