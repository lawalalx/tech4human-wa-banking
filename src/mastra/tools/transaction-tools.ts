import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  getMockBankBalance,
  getMockStatement,
  executeMockTransfer,
  payMockBill,
  getTransferStatus,
  validateBankAccount,
  purchaseMockAirtime,
} from "../../bank-api/external/register.js";
import {
  getAllLinkedAccounts,
  getLinkedAccount,
} from "../../utils/session-state.js";
import {
  hasTransactionPin,
  verifyStoredPin,
} from "../../utils/pin-store.js";

// NIBSS code of the bank this platform debits from (the customer's linked accounts)
const SOURCE_BANK_CODE = process.env.SOURCE_BANK_CODE || "011";

// ─── Shared types ─────────────────────────────────────────────────────────────
interface AccountSummary {
  accountNumber: string;
  maskedAccount: string;
  accountType: string;
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
    "ALWAYS use the phone extracted from the system context — look for 'Customer phone:' and take the number after it. " +
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
    linkAdvice: z.string().optional(),
  }),
  execute: async ({ phone }: { phone: string }) => {
    const accounts = await getAllLinkedAccounts(phone).catch(() => [] as Array<{ accountNumber: string }>);
    const hasPin = await hasTransactionPin(phone);

    if (!accounts.length) {
      return {
        found: false,
        hasPin,
       message:
          "No bank account is linked to this WhatsApp number yet. " +
          "If the customer just said 'Done' or claims they linked it, tell them: " +
          "'I'm sorry, but I still can't see a linked account on my end. Please ensure you completed the flow, or type Menu to go back.' " +
          "Otherwise, call add-new-account to send the secure Link Account Flow.",
      linkAdvice:
          "Tap 'Link Bank Account' and complete the secure flow to add your bank account to WhatsApp.",
      
      };
    }

    return {
      found: true,
      hasPin,
      message: `${accounts.length} linked account(s) found on this number.`,
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
    const status = await getTransferStatus(reference);

    if (!status.success || !status.data) {
      return {
        success: false,
        receiptText: "",
        message: status.message || `No transaction found for reference ${reference}.`,
      };
    }

    const fmtNaira = (n?: number) =>
      typeof n === "number"
        ? `NGN ${n.toLocaleString("en-NG", { minimumFractionDigits: 2 })}`
        : "—";
    const lines = [
      "🧾 *Transaction Receipt*",
      "──────────────────────",
      `Reference: ${status.rubyReference || reference}`,
      ...(status.bankReference ? [`Bank Ref: ${status.bankReference}`] : []),
      `Amount: ${fmtNaira(status.amount)}`,
      `Status: ${(status.status || "unknown").toUpperCase()}`,
      ...(status.sourceAccount ? [`From: ${status.sourceAccount} (${SOURCE_BANK_CODE})`] : []),
      ...(status.recipientAccount
        ? [`To: ${status.recipientAccount}${status.counterpartyBank ? ` — ${status.counterpartyBank}` : ""}`]
        : []),
      ...(status.narration ? [`Narration: ${status.narration}`] : []),
      ...(status.timestamp ? [`Date: ${new Date(status.timestamp).toLocaleString("en-NG")}`] : []),
      "──────────────────────",
      "Thank you for banking with us.",
    ];

    return {
      success: true,
      receiptText: lines.join("\n"),
      message: "Receipt generated.",
    };
  },
});


export const resolveCustomerAccountTool = createTool({
  id: "resolve-customer-account",
  description:
    "Look up the bank account(s) associated with the SENDER's phone number. " +
    "ALWAYS pass the phone extracted from the system context — look for 'Customer phone:' and take the number after it. " +
    "Call this FIRST before any balance, statement, transfer or insights tool. " +
    "If the phone is not registered, it prompts the agent to advise the customer to link their WhatsApp number. " +
    "If the customer has multiple accounts, it returns all masked accounts so the agent " +
    "can ask which one to use.",
  inputSchema: z.object({
    phone: z.string().describe("Phone number to look up (WhatsApp or registered)"),
  }),
  outputSchema: z.object({
    status: z.enum(["resolved", "multiple_accounts", "not_found"]),
    accountNumber: z.string().optional(),
    accountType: z.string().optional(),
    customerId: z.number().optional(),
    accounts: z
      .array(
        z.object({
          accountNumber: z.string(),
          maskedAccount: z.string(),
          accountType: z.string(),
        })
      )
      .optional(),
    message: z.string().optional(),
    linkAdvice: z.string().optional(),
  }),
  execute: async ({ phone }: { phone: string }) => {
    const accounts = await getAllLinkedAccounts(phone).catch(() => []);
    
    if (!accounts.length) {
      return {
        status: "not_found" as const,
        // 👇 UPDATE 1: Better AI instructions when no account is found 👇
        message:
          "No bank account is linked to this WhatsApp number yet. " +
          "Call 'add-new-account' to send the secure Link Account Flow. " +
          "IMPORTANT: Tell the customer 'Please tap the button below to link your account. Once completed, please type 'Check Balance' or 'Done' so I can verify.' " +
          "If the user already typed 'Done' and you are seeing this message, tell them: 'I still can't see the linked account. Please make sure you submitted the form, or type Menu to restart.'",
        linkAdvice:
            "Tap 'Link Bank Account' and complete the secure flow to add your bank account to WhatsApp.",
      };
    }

    if (accounts.length === 1) {
      return {
        status: "resolved" as const,
        accountNumber: accounts[0].accountNumber,
        accountType: accounts[0].accountType,
      };
    }

    return {
      status: "multiple_accounts" as const,
      accounts: accounts.map((a) => ({
        accountNumber: a.accountNumber,
        maskedAccount: a.maskedAccount,
        accountType: a.accountType,
      })),
      message: `You have ${accounts.length} accounts linked to this number.`,
    };
  },
});

// ─── Shared PIN + account gate ────────────────────────────────────────────────
// Every transaction tool funnels through here: resolve the linked account and
// verify the customer's 4-digit PIN BEFORE touching the external bank API.

type GateOk = { ok: true; accountNumber: string };

interface GateFailResult {
  found: boolean;
  error: string;
  pinRequired?: boolean;
  pinCreationRequired?: boolean;
  pinVerified?: boolean;
  attemptsRemaining?: number;
}

type GateFail = { ok: false; result: GateFailResult };



async function pinAndAccountGate(
  phone: string | undefined,
  accountNumber: string | undefined,
  pin: string | undefined
): Promise<GateOk | GateFail> {
  const sessionAccount = phone ? await getLinkedAccount(phone).catch(() => null) : null;
  const accounts = phone ? await getAllLinkedAccounts(phone).catch(() => []) : [];
  
  let account = accountNumber;
  if (!account) {
    const sessionAccNum = sessionAccount?.accountNumber || sessionAccount?.account_number;
    if (sessionAccNum) {
      account = sessionAccNum;
    } else if (accounts.length === 1) {
      account = accounts[0].accountNumber || accounts[0].account_number;
    }
  }

  if (!account) {
    if (!phone) return { ok: false, result: { found: false, error: "Provide the customer's phone or a pre-selected accountNumber." } };
    
    if (accounts.length > 1) {
      return {
        ok: false,
        result: {
          found: false,
          error:
            "MULTIPLE_ACCOUNTS: The customer has more than one linked account. Call resolve-customer-account to present the options and ask which account to use, then retry with that accountNumber.",
        },
      };
    }
    
    return {
      ok: false,
      result: {
        found: false,
        error:
          "NO_ACCOUNT: No bank account is linked to this WhatsApp number yet. Call add-new-account to send the secure Link Account Flow first. Tell the customer to type 'Done' when finished.",
      },
    };
  }

  // ── ACCOUNT IS FOUND & RESOLVED BEYOND THIS POINT ────────────────────────

  const hasPin = await hasTransactionPin(phone || "").catch(() => false);
  if (!hasPin) {
    return {
      ok: false,
      result: {
        found: true,
        pinCreationRequired: true,
        error:
          "🔐 The customer has NO transaction PIN yet. Call set-transaction-pin to send the secure PIN-setup Flow, tell the customer to complete it, then END YOUR TURN. Do NOT ask them to type a PIN in chat. After the flow completes, call this tool again and it will proceed.",
      },
    };
  }

  const trimmedPin = pin?.trim() ?? "";
  if (!/^\d{4}$/.test(trimmedPin)) {
    return {
      ok: false,
      result: {
        found: true,
        pinRequired: true,
        error: "🔐 Please enter your 4-digit transaction PIN to continue.",
      },
    };
  }

  const verify = await verifyStoredPin(phone || "", trimmedPin);
  if (verify.blocked) {
    return {
      ok: false,
      result: {
        found: true,
        pinVerified: false,
        attemptsRemaining: 0,
        error: `🔒 Your account is temporarily locked after too many incorrect PIN attempts.${
          verify.lockedMinutesRemaining ? ` Try again in ${verify.lockedMinutesRemaining} minute(s).` : ""
        }`,
      },
    };
  }
  if (!verify.verified) {
    return {
      ok: false,
      result: {
        found: true,
        pinVerified: false,
        attemptsRemaining: verify.attemptsRemaining ?? 0,
        error: `❌ Incorrect PIN. ${verify.attemptsRemaining ?? 0} attempt(s) remaining.`,
      },
    };
  }

  return { ok: true, accountNumber: account };
}

export const balanceEnquiryTool = createTool({
  id: "get-balance",
  description:
    "Retrieve real-time account balance. This tool handles PIN verification internally. " +
    "Pass 'phone' to auto-lookup (single account). " +
    "Pass 'accountNumber' directly when the customer has already chosen one from a multi-account selection. " +
    "If the customer has a PIN set, pass 'pin' extracted from their most recent message. " +
    "If pinCreationRequired=true is returned, respond by asking the customer to enter a new 4-digit transaction PIN, and call this tool again with pin=<their4Digits> once provided. " +
    "If pinRequired=true is returned, respond by asking the customer for their 4-digit transaction PIN and call this tool again with pin=<their4Digits>. " +
    "DO NOT call verify-transaction-pin separately for balance — this tool handles everything.",
  inputSchema: z.object({
    phone: z.string().optional().describe("Customer's phone — used to auto-lookup their account"),
    accountNumber: z.string().optional().describe("Pre-resolved account number (skip lookup)"),
    pin: z.string().optional().describe("4-digit PIN from the customer's most recent message — required when customer has a PIN set"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    maskedAccount: z.string().optional(),
    balance: z.number().optional(),
    currency: z.string().optional(),
    accountType: z.string().optional(),
    pinRequired: z.boolean().optional(),
    pinCreationRequired: z.boolean().optional(),
    pinVerified: z.boolean().optional(),
    attemptsRemaining: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ phone, accountNumber, pin }: { phone?: string; accountNumber?: string; pin?: string }) => {
    const gate = await pinAndAccountGate(phone, accountNumber, pin);
    if (!gate.ok) return gate.result;

    // NOTE: the external MockBank API stores balances in kobo — convert to Naira
    const bal = await getMockBankBalance(gate.accountNumber);
    if (!bal.success || bal.balance === undefined) {
      return { found: false, error: bal.message ?? "Balance is temporarily unavailable. Please try again shortly." };
    }
    const masked = gate.accountNumber.slice(0, 3) + "****" + gate.accountNumber.slice(-4);
    return {
      found: true,
      maskedAccount: masked,
      balance: bal.balance,
      currency: bal.currency ?? "NGN",
    };
  },
});

// ─── Mini Statement ───────────────────────────────────────────────────────────

export const miniStatementTool = createTool({
  id: "get-mini-statement",
  description:
    "Retrieve the last N transactions. This tool handles PIN verification internally. " +
    "Pass 'phone' to auto-lookup (single account). " +
    "Pass 'accountNumber' directly when the customer has already chosen from a multi-account selection. " +
    "If the customer has a PIN set, pass 'pin' extracted from their most recent message. " +
    "If 'pin' is missing but required, the tool returns pinRequired=true — " +
    "respond by asking the customer for their 4-digit transaction PIN and call this tool again with pin=<their4Digits>. " +
    "DO NOT call verify-transaction-pin separately for mini-statement — this tool handles everything.",
  inputSchema: z.object({
    phone: z.string().optional().describe("Customer's phone number — auto-lookup account"),
    accountNumber: z.string().optional().describe("Pre-resolved account number (skip lookup)"),
    limit: z.number().optional().default(10),
    pin: z.string().optional().describe("4-digit PIN from the customer's most recent message — required when customer has a PIN set"),
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
        description: z.string().nullable().optional(),
      })
    ).optional(),
    pinRequired: z.boolean().optional(),
    pinCreationRequired: z.boolean().optional(),
    pinVerified: z.boolean().optional(),
    attemptsRemaining: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ phone, accountNumber, limit = 10, pin }: { phone?: string; accountNumber?: string; limit?: number; pin?: string }) => {
    const gate = await pinAndAccountGate(phone, accountNumber, pin);
    if (!gate.ok) return { ...gate.result, transactions: [] };

    const stmt = await getMockStatement(gate.accountNumber, SOURCE_BANK_CODE, 1, Math.min(Math.max(limit, 1), 20));
    if (!stmt.success) {
      return { found: false, error: stmt.message ?? "Statement is temporarily unavailable.", transactions: [] };
    }
    const an = gate.accountNumber;
    const masked = an.slice(0, 3) + "****" + an.slice(-4);
    return {
      found: true,
      maskedAccount: masked,
      transactions: stmt.transactions.map((txn) => ({
        date: txn.date,
        type: txn.type,
        amount: txn.amount,
        currency: txn.currency ?? "NGN",
        reference: String(txn.reference ?? "N/A"),
        description: txn.description ?? undefined,
      })),
    };
  },
});

// ─── Account Name Verification ────────────────────────────────────────────────

export const verifyAccountNameTool = createTool({
  id: "verify-account-name",
  description:
    "Verify the recipient's account name before any transfer or bill payment. " +
    "Calls the external bank API validate-account endpoint which resolves the account name " +
    "and triggers an OTP dispatch to the phone number registered on that account. " +
    "Use NIBSS codes e.g. '011' First Bank, '058' GTBank, '044' Access.",
  inputSchema: z.object({
    accountNumber: z.string().describe("Destination account number"),
    bankCode: z.string().describe("NIBSS bank code of the destination bank (e.g. '058' for GTBank)"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    accountName: z.string().optional(),
    otpReference: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ accountNumber, bankCode }: { accountNumber: string; bankCode: string }) => {
    const result = await validateBankAccount(accountNumber, bankCode);
    if (!result.success || !result.data) {
      return { found: false, error: result.error ?? result.message ?? "Account could not be validated. Please check the account number and bank." };
    }
    return {
      found: true,
      accountName: (result.data as any)?.accountName ?? (result.data as any)?.account_name ?? undefined,
      otpReference: (result.data as any)?.otpReference ?? undefined,
    };
  },
});

// ─── Intra-bank Transfer ──────────────────────────────────────────────────────

export const intraTransferTool = createTool({
  id: "execute-intra-transfer",
  description:
    "Execute an INTERNAL (same-bank) fund transfer from the customer's linked account. " +
    "This tool verifies the customer's transaction PIN internally — always pass 'pin'. " +
    "Only call AFTER the recipient's name has been confirmed. Returns the Ruby reference on success.",
  inputSchema: z.object({
    phone: z.string().describe("Customer's WhatsApp phone number from context"),
    fromAccount: z.string().optional().describe("Debit account number — omit when the customer has a single linked account"),
    toAccount: z.string().describe("Recipient's internal account number"),
    amount: z.number().positive().describe("Amount in NGN"),
    narration: z.string().optional().default("WhatsApp Transfer").describe("Transfer narration / description"),
    pin: z.string().describe("4-digit PIN from the customer's most recent message"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    reference: z.string().optional(),
    status: z.string().optional(),
    message: z.string(),
    pinRequired: z.boolean().optional(),
    pinCreationRequired: z.boolean().optional(),
    pinVerified: z.boolean().optional(),
    attemptsRemaining: z.number().optional(),
  }),
  execute: async ({
    phone,
    fromAccount,
    toAccount,
    amount,
    narration,
    pin,
  }: {
    phone: string;
    fromAccount?: string;
    toAccount: string;
    amount: number;
    narration?: string;
    pin: string;
  }) => {
    const gate = await pinAndAccountGate(phone, fromAccount, pin);
    if (!gate.ok) {
      const r = gate.result as any;
      return {
        success: false,
        message: String(r?.error ?? "Transfer blocked."),
        pinRequired: r?.pinRequired,
        pinCreationRequired: r?.pinCreationRequired,
        pinVerified: r?.pinVerified,
        attemptsRemaining: r?.attemptsRemaining,
      };
    }

    const reference = `RUBY-${Date.now()}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const result = await executeMockTransfer({
      reference,
      sourceAccount: gate.accountNumber,
      sourceBankCode: SOURCE_BANK_CODE,
      destinationAccount: toAccount,
      destinationBankCode: SOURCE_BANK_CODE,
      amountKobo: Math.round(amount * 100),
      narration: narration || "WhatsApp Transfer",
    });
    return {
      success: result.success,
      reference: result.reference,
      status: result.status,
      message: result.message ?? (result.success ? "Transfer successful." : "Transfer failed."),
    };
  },
});

// ─── Interbank Transfer ───────────────────────────────────────────────────────

export const interBankTransferTool = createTool({
  id: "execute-interbank-transfer",
  description:
    "Execute an INTERBANK fund transfer from the customer's linked account to another Nigerian bank. " +
    "This tool verifies the customer's transaction PIN internally — always pass 'pin'. " +
    "Use verify-account-name first to confirm the destination, then this tool. Returns the Ruby reference.",
  inputSchema: z.object({
    phone: z.string().describe("Customer's WhatsApp phone number from context"),
    fromAccount: z.string().optional().describe("Debit account number — omit when the customer has a single linked account"),
    toAccount: z.string().describe("Recipient's account number at the destination bank"),
    toBankCode: z.string().describe("NIBSS bank code of destination bank (e.g. '058' GTBank)"),
    amount: z.number().positive().describe("Amount in NGN"),
    narration: z.string().optional().default("WhatsApp Transfer").describe("Transfer narration"),
    pin: z.string().describe("4-digit PIN from the customer's most recent message"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    reference: z.string().optional(),
    status: z.string().optional(),
    message: z.string(),
    pinRequired: z.boolean().optional(),
    pinCreationRequired: z.boolean().optional(),
    pinVerified: z.boolean().optional(),
    attemptsRemaining: z.number().optional(),
  }),
  execute: async ({
    phone,
    fromAccount,
    toAccount,
    toBankCode,
    amount,
    narration,
    pin,
  }: {
    phone: string;
    fromAccount?: string;
    toAccount: string;
    toBankCode: string;
    amount: number;
    narration?: string;
    pin: string;
  }) => {
    const gate = await pinAndAccountGate(phone, fromAccount, pin);
    if (!gate.ok) {
      const r = gate.result as any;
      return {
        success: false,
        message: String(r?.error ?? "Transfer blocked."),
        pinRequired: r?.pinRequired,
        pinCreationRequired: r?.pinCreationRequired,
        pinVerified: r?.pinVerified,
        attemptsRemaining: r?.attemptsRemaining,
      };
    }

    const reference = `RUBY-${Date.now()}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const result = await executeMockTransfer({
      reference,
      sourceAccount: gate.accountNumber,
      sourceBankCode: SOURCE_BANK_CODE,
      destinationAccount: toAccount,
      destinationBankCode: toBankCode,
      amountKobo: Math.round(amount * 100),
      narration: narration || "WhatsApp Transfer",
    });
    return {
      success: result.success,
      reference: result.reference,
      status: result.status,
      message: result.message ?? (result.success ? "Transfer successful." : "Transfer failed."),
    };
  },
});

// ─── Transfer Status ──────────────────────────────────────────────────────────

export const transferStatusTool = createTool({
  id: "get-transfer-status",
  description:
    "Check the status of a previous transfer by its Ruby reference (e.g. RUBY-...) or bank reference (ACC-...). " +
    "Returns the current status, amount and recipient details. No PIN required for status lookups.",
  inputSchema: z.object({
    reference: z.string().describe("The Ruby or bank reference of the transfer to query"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    status: z.string().optional(),
    rubyReference: z.string().optional(),
    bankReference: z.string().optional(),
    amount: z.number().optional(),
    recipientAccount: z.string().optional(),
    counterpartyBank: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ reference }: { reference: string }) => {
    const result = await getTransferStatus(reference);
    if (!result.success) return { found: false, error: result.message ?? "Could not find a transaction with that reference." };
    return {
      found: true,
      status: result.status,
      rubyReference: result.rubyReference,
      bankReference: result.bankReference,
      amount: result.amount,
      recipientAccount: result.recipientAccount,
      counterpartyBank: result.counterpartyBank,
    };
  },
});

// ─── Bill Payment ─────────────────────────────────────────────────────────────

export const billPaymentTool = createTool({
  id: "execute-bill-payment",
  description:
    "Execute a bill payment (DSTV/GoTV, electricity, water, waste, airtime etc.) from the customer's linked account. " +
    "This tool verifies the customer's transaction PIN internally — always pass 'pin'. " +
    "Validate the biller with validate-biller first. Amount is in NGN; customerReference is the smart-card/IUC/meter number.",
  inputSchema: z.object({
    phone: z.string().describe("Customer's WhatsApp phone number from context"),
    fromAccount: z.string().optional().describe("Debit account number — omit when the customer has a single linked account"),
    billerName: z.string().describe("Biller name or code (e.g. DSTV, EKEDC, LAWMA)"),
    customerReference: z.string().describe("Customer's smart-card / IUC / meter number"),
    amount: z.number().positive().describe("Amount in NGN"),
    pin: z.string().describe("4-digit PIN from the customer's most recent message"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    reference: z.string().optional(),
    message: z.string(),
    pinRequired: z.boolean().optional(),
    pinCreationRequired: z.boolean().optional(),
    pinVerified: z.boolean().optional(),
    attemptsRemaining: z.number().optional(),
  }),
  execute: async ({
    phone,
    fromAccount,
    billerName,
    customerReference,
    amount,
    pin,
  }: {
    phone: string;
    fromAccount?: string;
    billerName: string;
    customerReference: string;
    amount: number;
    pin: string;
  }) => {
    // Normalise the biller against the supported list
    const upper = billerName.toUpperCase().trim();
    const match = KNOWN_BILLERS.find((b) => upper.includes(b) || b.includes(upper));
    if (!match) {
      return { success: false, message: `Biller '${billerName}' is not supported. Supported: DSTV, GOTV, STARTIMES, SHOWMAX, EKEDC, IKEDC, AEDC, PHEDC, IBEDC, EEDC, MTN, AIRTEL, GLO, 9MOBILE, LAWMA.` };
    }

    const gate = await pinAndAccountGate(phone, fromAccount, pin);
    if (!gate.ok) {
      const r = gate.result as any;
      return {
        success: false,
        message: String(r?.error ?? "Bill payment blocked."),
        pinRequired: r?.pinRequired,
        pinCreationRequired: r?.pinCreationRequired,
        pinVerified: r?.pinVerified,
        attemptsRemaining: r?.attemptsRemaining,
      };
    }

    const reference = `BILL-${Date.now()}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const result = await payMockBill({
      reference,
      sourceAccount: gate.accountNumber,
      sourceBankCode: SOURCE_BANK_CODE,
      billerCode: match,
      billerName: match,
      customerReference,
      amountKobo: Math.round(amount * 100),
    });
    return {
      success: result.success,
      reference: result.reference,
      message: result.message ?? (result.success ? "Bill payment successful." : "Bill payment failed."),
    };
  },
});

// ─── Validate Biller ──────────────────────────────────────────────────────────
// The external MockBank API takes a free-form billerCode — this allowlist keeps
// the agent from paying unrecognised billers before execute-bill-payment runs.

const KNOWN_BILLERS = ["DSTV", "GOTV", "STARTIMES", "SHOWMAX", "EKEDC", "IKEDC", "AEDC", "PHEDC",
  "IBEDC", "EEDC", "JED", "KAEDCO", "MTN", "AIRTEL", "GLO", "9MOBILE",
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

// ─── Airtime Purchase ────────────────────────────────────────────────────────

export const airtimePurchaseTool = createTool({
  id: "purchase-airtime",
  description:
    "Buy airtime top-up for any phone number from the customer's linked account. " +
    "This tool verifies the customer's transaction PIN internally — always pass 'pin'. " +
    "Network must be one of MTN, AIRTEL, GLO, 9MOBILE.",
  inputSchema: z.object({
    phone: z.string().describe("Customer's WhatsApp phone number from context"),
    fromAccount: z.string().optional().describe("Debit account number — omit when the customer has a single linked account"),
    targetPhone: z.string().describe("Phone number to top up (e.g. 09047747474)"),
    network: z.enum(["MTN", "AIRTEL", "GLO", "9MOBILE"]).describe("Mobile network operator"),
    amount: z.number().positive().describe("Amount in NGN"),
    pin: z.string().describe("4-digit PIN from the customer's most recent message"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    reference: z.string().optional(),
    bankReference: z.string().optional(),
    message: z.string(),
    pinRequired: z.boolean().optional(),
    pinCreationRequired: z.boolean().optional(),
    attemptsRemaining: z.number().optional(),
  }),
  execute: async ({
    phone,
    fromAccount,
    targetPhone,
    network,
    amount,
    pin,
  }: {
    phone: string;
    fromAccount?: string;
    targetPhone: string;
    network: string;
    amount: number;
    pin: string;
  }) => {
    const gate = await pinAndAccountGate(phone, fromAccount, pin);
    if (!gate.ok) {
      const r = gate.result as GateFailResult;
      return {
        success: false,
        message: r.error,
        pinRequired: r.pinRequired,
        pinCreationRequired: r.pinCreationRequired,
        attemptsRemaining: r.attemptsRemaining,
      };
    }

    const reference = `AIR-${Date.now()}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const result = await purchaseMockAirtime({
      reference,
      sourceAccount: gate.accountNumber,
      sourceBankCode: SOURCE_BANK_CODE,
      phoneNumber: targetPhone,
      network,
      amountKobo: Math.round(amount * 100),
    });

    return {
      success: result.success,
      reference,
      bankReference: result.bankReference,
      message: result.message ?? (result.success ? "Airtime purchase successful." : "Airtime purchase failed."),
    };
  },
});
