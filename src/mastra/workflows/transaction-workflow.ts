import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { generateText } from "ai";
import { getChatModel } from "../core/llm/provider.js";
import {
  balanceEnquiryTool,
  miniStatementTool,
  resolveCustomerAccountTool,
  lookupCustomerByAccountTool,
  intraTransferTool,
  billPaymentTool,
  validateBillerTool,
  generateReceiptTool,
} from "../tools/transaction-tools.js";
import { checkHasPinTool, createTransactionPinTool, verifyTransactionPinTool } from "../tools/pin-tools.js";
import { sendPhoneVerificationOtpTool, verifyPhoneVerificationOtpTool } from "../tools/onboarding-tools.js";
import { clearPendingFlow, getSessionState, setPendingFlow } from "../../utils/session-state.js";

const intentSchema = z.object({
  intent: z.enum(["balance", "mini_statement", "transfer", "bill_payment", "unknown"]),
  affirm: z.boolean().default(false),
  cancel: z.boolean().default(false),
  resend: z.boolean().default(false),
  pin: z.string().optional(),
  otp: z.number().optional(),
  amount: z.number().optional(),
  recipientAccount: z.string().optional(),
  billerName: z.string().optional(),
  billReference: z.string().optional(),
  narration: z.string().optional(),
});

const confirmationDecisionSchema = z.object({
  decision: z.enum(["proceed", "cancel", "unclear"]),
});

function safeParseIntent(text: string): IntentData {
  const candidates: string[] = [];
  candidates.push(text);

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    candidates.push(fencedMatch[1]);
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate.trim());
      const parsed = intentSchema.safeParse(obj);
      if (parsed.success) return parsed.data;
    } catch {
      // Try next candidate.
    }
  }

  return {
    intent: "unknown",
    affirm: false,
    cancel: false,
    resend: false,
  };
}

type IntentData = z.infer<typeof intentSchema>;
type ConfirmationDecision = z.infer<typeof confirmationDecisionSchema>["decision"];

const actionSchema = z.enum(["balance", "mini_statement", "transfer", "bill_payment"]);
type TransactionAction = z.infer<typeof actionSchema>;

function money(amount: number): string {
  return `₦${amount.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function maskAccount(account: string): string {
  if (account.length < 8) return account;
  return `${account.slice(0, 3)}****${account.slice(-4)}`;
}

function asFourDigits(value?: string): string | null {
  if (!value) return null;
  const v = value.trim();
  return /^\d{4}$/.test(v) ? v : null;
}

function asAmount(value?: string): number | null {
  if (!value) return null;
  const raw = value.trim().toLowerCase();
  const compact = raw.replace(/[\s,]/g, "");
  // Avoid treating account-number-like messages as transfer amounts.
  if (/^\d{9,10}$/.test(compact)) return null;
  const match = compact.match(/(\d+(?:\.\d+)?)(k|m)?/i);
  if (!match) return null;

  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return null;

  const suffix = (match[2] || "").toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  return Math.round(base * multiplier);
}

function asOtp(value?: string): number | null {
  if (!value) return null;
  const match = value.match(/\b\d{4,8}\b/);
  if (!match) return null;
  const otp = Number(match[0]);
  return Number.isFinite(otp) ? otp : null;
}

function asAccountNumber(value?: string): string | null {
  if (!value) return null;
  // Prefer a strict 10-digit account token not attached to other digits.
  const tenDigit = value.match(/(?<!\d)\d{10}(?!\d)/);
  if (tenDigit) return tenDigit[0];

  // Fallback for edge integrations that may still use 9-digit internal ids.
  const nineDigit = value.match(/(?<!\d)\d{9}(?!\d)/);
  return nineDigit ? nineDigit[0] : null;
}

function asBillReference(value?: string): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, "");
  const match = cleaned.match(/\b\d{8,16}\b/);
  return match ? match[0] : null;
}

function asTxnLimit(value?: string): number | null {
  if (!value) return null;
  const text = value.toLowerCase();
  const match = text.match(/(?:last|recent)?\s*(\d{1,2})\s*(?:transactions?|txns?|statement)/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(20, Math.max(1, parsed));
}

function asNarration(value?: string): string | null {
  if (!value) return null;
  const text = value.trim();
  const explicit = text.match(/(?:description|narration|note)\s*[:=-]\s*(.+)$/i);
  if (explicit?.[1]) return explicit[1].trim().slice(0, 80);

  const natural = text.match(/\bfor\s+([a-z][a-z0-9\s,&-]{2,80})$/i);
  if (natural?.[1]) return natural[1].trim().slice(0, 80);

  return null;
}

function shouldBypassTransactionRouting(message: string): boolean {
  const text = (message || "").toLowerCase();

  const insightsKeywords = [
    "insight",
    "spending",
    "budget",
    "credit score",
    "credit health",
    "finance analysis",
    "chart",
    "graph",
    "trend",
    "pie",
    "bar",
    "line",
    "savings",
  ];

  const transactionKeywords = [
    "balance",
    "statement",
    "mini statement",
    "transaction pin",
    "transfer",
    "send money",
    "pay bill",
    "bill payment",
    "airtime",
    "data bundle",
    "dstv",
    "gotv",
    "electricity",
    "meter",
  ];

  const hasInsightsKeyword = insightsKeywords.some((keyword) => text.includes(keyword));
  const hasTransactionKeyword = transactionKeywords.some((keyword) => text.includes(keyword));

  return hasInsightsKeyword && !hasTransactionKeyword;
}

function parseReceiptDetails(receiptText?: string): Record<string, string> {
  const details: Record<string, string> = {};
  if (!receiptText) return details;

  for (const rawLine of receiptText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cleaned = line.replace(/^[-*\u2022]\s*/, "");
    const match = cleaned.match(/^\*?([^:*]+)\*?:\s*(.+)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (!value) continue;

    if (key.includes("date")) details.date = value;
    else if (key.includes("reference")) details.reference = value;
    else if (key.includes("account name")) details.accountName = value;
    else if (key.includes("amount")) details.amount = value;
    else if (key.includes("description")) details.description = value;
    else if (key.includes("status")) details.status = value;
  }

  return details;
}

function formatTransferReceiptMessage(params: {
  receiptText?: string;
  reference?: string;
}): string {
  const parsed = parseReceiptDetails(params.receiptText);
  const lines = [
    "Transfer successful. Here is your receipt:",
    `1. Date and time: ${parsed.date || "N/A"}`,
    `2. Reference: ${parsed.reference || params.reference || "N/A"}`,
    `3. Beneficiary: ${parsed.accountName || "N/A"}`,
    `4. Amount: ${parsed.amount || "N/A"}`,
    `5. Description: ${parsed.description || "Transfer"}`,
    `6. Status: ${parsed.status || "SUCCESSFUL"}`,
  ];
  return lines.join("\n");
}

function fallbackParseIntentData(message: string): IntentData {
  const text = message.trim();
  const pin = asFourDigits(text) ?? undefined;
  const otp = asOtp(text) ?? undefined;
  const amount = asAmount(text) ?? undefined;
  const recipientAccount = asAccountNumber(text) ?? undefined;
  const billReference = asBillReference(text) ?? undefined;

  return {
    intent: "unknown",
    affirm: false,
    cancel: false,
    resend: false,
    pin,
    otp,
    amount,
    recipientAccount,
    billerName: undefined,
    billReference,
    narration: undefined,
  };
}

function mergeIntentData(fallbackParsed: IntentData, parsedByLlm: IntentData): IntentData {
  const pick = <T>(primary: T | null | undefined, fallback: T | null | undefined): T | undefined => {
    if (primary === null || primary === undefined) return fallback ?? undefined;
    if (typeof primary === "string" && !primary.trim()) return (fallback as T | undefined) ?? undefined;
    return primary;
  };

  return {
    intent: parsedByLlm.intent !== "unknown" ? parsedByLlm.intent : fallbackParsed.intent,
    affirm: Boolean(parsedByLlm.affirm || fallbackParsed.affirm),
    cancel: Boolean(parsedByLlm.cancel || fallbackParsed.cancel),
    resend: Boolean(parsedByLlm.resend || fallbackParsed.resend),
    pin: pick(parsedByLlm.pin, fallbackParsed.pin),
    otp: pick(parsedByLlm.otp, fallbackParsed.otp),
    amount: pick(parsedByLlm.amount, fallbackParsed.amount),
    recipientAccount: pick(parsedByLlm.recipientAccount, fallbackParsed.recipientAccount),
    billerName: pick(parsedByLlm.billerName, fallbackParsed.billerName),
    billReference: pick(parsedByLlm.billReference, fallbackParsed.billReference),
    narration: pick(parsedByLlm.narration, fallbackParsed.narration),
  };
}


async function resolveTransferStatementAmbiguity(intentData: IntentData, message: string): Promise<IntentData> {
  const hasTransferDetails = Boolean(
    intentData.amount ||
    intentData.recipientAccount ||
    asAmount(message) ||
    asAccountNumber(message)
  );

  if (hasTransferDetails) return intentData;
  if (intentData.intent !== "transfer" && intentData.intent !== "unknown") return intentData;

  try {
    const result = await generateText({
      model: getChatModel(),
      prompt:
        "Return ONLY compact JSON with one key: intent. " +
        "intent must be one of: mini_statement, transfer, unknown. " +
        "Classify by meaning, not exact keywords. " +
        "If the customer is asking to VIEW or CHECK transaction records/history/statement (including transfer records), return mini_statement. " +
        "If the customer is asking to EXECUTE or SEND a new transfer, return transfer. " +
        "If ambiguous, return unknown.\n\n" +
        `Message: ${message}`,
    });

    const parsed = safeParseIntent(result.text).intent;
    if (parsed === "mini_statement") return { ...intentData, intent: "mini_statement" };
    if (parsed === "transfer") return { ...intentData, intent: "transfer" };
    return intentData;
  } catch {
    return intentData;
  }
}


function buildTransferDetailsChecklist(): string {
  return (
    "Please provide the following to continue your transfer:\n" +
    "1. Amount to send\n" +
    "2. Recipient account number\n" +
    "3. Description / narration (optional, e.g. \"for food\", \"for transport\")."
  );
}

function safeParseConfirmationDecision(text: string): ConfirmationDecision {
  const candidates: string[] = [text];

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    candidates.push(fencedMatch[1]);
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate.trim());
      const parsed = confirmationDecisionSchema.safeParse(obj);
      if (parsed.success) return parsed.data.decision;
    } catch {
      // Try next candidate.
    }
  }

  return "unclear";
}

async function interpretPendingDecision(params: {
  message: string;
  flowAction: "transfer" | "bill_payment";
  stage: "summary_confirmation" | "final_confirmation";
  details: Record<string, string | number | boolean | null | undefined>;
  fallback: Pick<IntentData, "affirm" | "cancel">;
}): Promise<ConfirmationDecision> {
  try {
    const result = await generateText({
      model: getChatModel(),
      prompt:
        "Return ONLY compact JSON with one key: decision. " +
        "decision must be one of: proceed, cancel, unclear. " +
        "Interpret natural customer language in an in-progress banking confirmation semantically, not by exact keywords. " +
        "Support typos, slang, short replies, and conversational phrasing. " +
        "If the user clearly wants to continue, return proceed. If they clearly want to stop, return cancel. " +
        "If the message is a question, unrelated, ambiguous, or changes topic without clearly cancelling the active confirmation, return unclear.\n\n" +
        `Flow: ${params.flowAction}\n` +
        `Stage: ${params.stage}\n` +
        `Context: ${JSON.stringify(params.details)}\n` +
        `Customer message: ${params.message}`,
    });

    return safeParseConfirmationDecision(result.text);
  } catch {
    if (params.fallback.cancel) return "cancel";
    if (params.fallback.affirm) return "proceed";
    return "unclear";
  }
}

async function composeConversationalReply(params: {
  purpose: string;
  details: Record<string, string | number | boolean | null | undefined>;
  requiredSuffix?: string;
}): Promise<string> {
  const result = await generateText({
    model: getChatModel(),
    prompt:
      "Write a short, natural WhatsApp banking reply. " +
      "You must sound and speak as a human customer agent from First Bank Nigeria. " +
      "Do not mention internal tools, workflows, or hidden state. " +
      "Keep it friendly, clear, conversational and empathetic. " +
      "Do not use markdown tables. " +
      `Purpose: ${params.purpose}\n` +
      `Details: ${JSON.stringify(params.details)}\n` +
      (params.requiredSuffix ? `Required ending: ${params.requiredSuffix}\n` : "") +
      "Return only the final customer-facing message.",
  });

  const reply = result.text.trim();
  if (!params.requiredSuffix) return reply;
  if (reply.toLowerCase().includes(params.requiredSuffix.toLowerCase())) return reply;
  return `${reply}\n${params.requiredSuffix}`.trim();
}

async function inferCoarseIntent(message: string): Promise<IntentData["intent"]> {
  try {
    const result = await generateText({
      model: getChatModel(),
      prompt:
        "Return ONLY compact JSON with one key: intent. " +
        "intent must be one of: balance, mini_statement, transfer, bill_payment, unknown. " +
        "Classify even short or underspecified customer intents such as single-word requests. " +
        "If the user intent is unclear or unrelated, return unknown.\n\n" +
        `Message: ${message}`,
    });

    const parsed = safeParseIntent(result.text);
    return parsed.intent;
  } catch {
    return "unknown";
  }
}

const understandMessageStep = createStep({
  id: "understand-message",
  inputSchema: z.object({
    phone: z.string(),
    message: z.string(),
    action: actionSchema.optional(),
  }),
  outputSchema: z.object({
    phone: z.string(),
    message: z.string(),
    action: actionSchema.optional(),
    intentData: intentSchema,
  }),
  execute: async ({ inputData }) => {
    const fallbackParsed = fallbackParseIntentData(inputData.message);
    let mergedIntentData: IntentData = fallbackParsed;

    try {
      const result = await generateText({
        model: getChatModel(),
        prompt:
          "Return ONLY compact JSON for transaction intent classification with keys: " +
          "intent, affirm, cancel, resend, pin, otp, amount, recipientAccount, billerName, billReference, narration. " +
          "intent must be one of: balance, mini_statement, transfer, bill_payment, unknown. " +
          "Interpret natural conversational approvals like sure, go ahead, that works, do it, and okay as affirm=true when they clearly mean proceed. " +
          "Interpret natural conversational cancellations like not now, stop this, leave it, cancel it, and never mind as cancel=true when they clearly mean stop. " +
          "If the message mentions a known biller or payment service, set billerName to the provider or service name mentioned by the customer. " +
          "Use null for unknown optional fields. " +
          "No markdown, no prose, only JSON.\n\n" +
          `Message: ${inputData.message}`,
      });

      const intentData = safeParseIntent(result.text);
      mergedIntentData = await resolveTransferStatementAmbiguity(
        mergeIntentData(fallbackParsed, intentData),
        inputData.message
      );

      if (mergedIntentData.intent === "unknown") {
        const coarseIntent = await inferCoarseIntent(inputData.message);
        if (coarseIntent !== "unknown") {
          mergedIntentData = {
            ...mergedIntentData,
            intent: coarseIntent,
          };
          mergedIntentData = await resolveTransferStatementAmbiguity(mergedIntentData, inputData.message);
        }
      }
    } catch {
      mergedIntentData = fallbackParsed;

      if (mergedIntentData.intent === "unknown") {
        const coarseIntent = await inferCoarseIntent(inputData.message);
        if (coarseIntent !== "unknown") {
          mergedIntentData = {
            ...mergedIntentData,
            intent: coarseIntent,
          };
          mergedIntentData = await resolveTransferStatementAmbiguity(mergedIntentData, inputData.message);
        }
      }
    }

    return {
      phone: inputData.phone,
      message: inputData.message,
      action: inputData.action,
      intentData: mergedIntentData,
    };
  },
});

const executeConversationFlowStep = createStep({
  id: "execute-conversation-flow",
  inputSchema: z.object({
    phone: z.string(),
    message: z.string(),
    action: actionSchema.optional(),
    intentData: intentSchema,
  }),
  outputSchema: z.object({
    handled: z.boolean(),
    reply: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { phone, intentData } = inputData;
    const action = inputData.action || intentData.intent;
    const session = await getSessionState(phone).catch(() => null);
    const pending = session?.pending_flow;
    const { message } = inputData;
    const trimmedMessage = message.trim();
    const isEndCommand = /^end$/i.test(trimmedMessage);
    // If there's a pending flow, use the raw message for PIN extraction.
    // This ensures "1234" is treated as PIN input, not parsed by LLM.
    const directPin = asFourDigits(message);

    const describeAction = (pendingAction: string): string => {
      if (pendingAction === "balance") return "balance request";
      if (pendingAction === "mini_statement") return "mini statement";
      if (pendingAction === "transfer") return "transfer";
      if (pendingAction === "bill_payment") return "bill payment";
      return "current request";
    };

    const humanReply = async (params: {
      purpose: string;
      details: Record<string, string | number | boolean | null | undefined>;
      requiredSuffix: string;
      fallback: string;
    }) => {
      return params.requiredSuffix;
    };

    const terminateFlowIfRequested = async () => {
      if (!isEndCommand) return null;
      if (!pending) {
        return {
          handled: true,
          reply: "I have ended that request. Tell me what you want to do next.",
        };
      }
      const activeFlow = describeAction(String(pending.action || "request"));
      await clearPendingFlow(phone).catch(() => {});
      return {
        handled: true,
        reply: "I have ended that request. Tell me what you want to do next.",
      };
    };

    const remindActiveFlow = async (params: {
      pendingAction: string;
      currentStep: string;
      nextInstruction: string;
      fallback: string;
    }) => {
      return {
        handled: true,
        reply: `${params.nextInstruction}\nIf you want to cancel this request and switch topics, type END.`,
      };
    };

    const ended = await terminateFlowIfRequested();
    if (ended) return ended;


    // =====================================================
    // Let supervisor route clear insights/chart/budget/credit intents.
    if (!pending && shouldBypassTransactionRouting(trimmedMessage)) {
      return {
        handled: true,
        reply: TRANSACTION_UNKNOWN_REPLY,
      };
    }

    if (!pending && /^(ok|okay|alright|fine|thanks|thank you|cool|sure)$/i.test(trimmedMessage)) {
      return {
        handled: true,
        reply: await humanReply({
          purpose: "acknowledge a short customer acknowledgement and ask for the next request",
          details: {},
          requiredSuffix:
            "Great. Tell me what you want to do next and I will guide you. You can ask for balance, mini statement, transfer, or bill payment.",
          fallback:
            "Great. Tell me what you want to do next and I will guide you. You can ask for balance, mini statement, transfer, or bill payment.",
        }),
      };
    }

    // =============================================



    const runBalance = async (pin?: string) => {
      const result = await (balanceEnquiryTool as any).execute({ phone, pin });
      
      const safeBalanceError =
        typeof result?.error === "string" && result.error.trim().length > 0
          ? result.error
          : "Unable to fetch balance right now.";
      
          if (!result?.found) {
        if (result?.pinCreationRequired) {
          // PIN creation is mandatory before balance inquiry
          await setPendingFlow(phone, {
            action: "balance",
            step: "awaiting_new_pin",
            data: { intent: "balance" },
            started_at: new Date().toISOString(),
          });
          return {
            handled: true,
            reply: await humanReply({
              purpose: "ask the user that to continue they will need  to create a new transaction pin before balance inquiry",
              details: { action: "balance" },
              requiredSuffix: "🔐 Please enter a new 4-digit transaction PIN to secure your account.",
              fallback: "🔐 Please enter a new 4-digit transaction PIN to secure your account.",
            }),
          };
        }
        if (result?.pinRequired) {
          await setPendingFlow(phone, {
            action: "balance",
            step: "awaiting_pin",
            data: { intent: "balance" },
            started_at: new Date().toISOString(),
          });
          return {
            handled: true,
            reply: "🔐 Please enter your 4-digit transaction PIN to view your balance.",
          };
        }
        return {
          handled: true,
          reply: safeBalanceError,
        };
      }
      await clearPendingFlow(phone).catch(() => {});
      const balanceTimestamp = new Date().toLocaleString("en-NG", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Africa/Lagos",
      });
      return {
        handled: true,
        reply:
          "💰 Balance Summary\n" +
          `1. 🏦 Account: ${result.maskedAccount || "N/A"}\n` +
          `2. 📂 Account Type: ${result.accountType || "N/A"}\n` +
          `3. 💵 Available Balance: ${money(Number(result.balance || 0))}\n` +
          `4. 🌍 Currency: ${result.currency || "NGN"}\n` +
          `5. 🕒 Checked At: ${balanceTimestamp}`,
      };
    };

    const runStatement = async (pin?: string, requestedLimit = 10) => {
      const statementLimit = Math.min(20, Math.max(1, Number(requestedLimit || 10)));
      const result = await (miniStatementTool as any).execute({ phone, pin, limit: statementLimit });
      const safeStatementError =
        typeof result?.error === "string" && result.error.trim().length > 0
          ? result.error
          : "Unable to fetch mini statement right now.";

      if (!result?.found) {
        if (result?.pinCreationRequired) {
          // PIN creation is mandatory before statement retrieval
          await setPendingFlow(phone, {
            action: "mini_statement",
            step: "awaiting_new_pin",
            data: { intent: "mini_statement", statementLimit },
            started_at: new Date().toISOString(),
          });
          return {
            handled: true,
            reply: await humanReply({
              purpose: "ask the user to create a new transaction pin before mini statement",
              details: { action: "mini_statement" },
              requiredSuffix: "🔐 Please enter a new 4-digit transaction PIN to secure your account.",
              fallback: "🔐 Please enter a new 4-digit transaction PIN to secure your account.",
            }),
          };
        }
        if (result?.pinRequired) {
          await setPendingFlow(phone, {
            action: "mini_statement",
            step: "awaiting_pin",
            data: { intent: "mini_statement", statementLimit },
            started_at: new Date().toISOString(),
          });
        }
        return { handled: true, reply: safeStatementError };
      }
      await clearPendingFlow(phone).catch(() => {});

      const txns = (result.transactions || []).slice(0, statementLimit);
      if (!txns.length) {
        return {
          handled: true,
          reply: `No transactions found in your last ${statementLimit} records.`,
        };
      }

      const lines = txns.map((txn: any) => {
        const dateText = new Date(txn.date).toLocaleString("en-NG", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "Africa/Lagos",
        });
        const direction = String(txn.type || "").toLowerCase().includes("debit") ? "🔴 Debit" : "🟢 Credit";
        const description = txn.description || txn.type || "Transaction";
        return `• ${dateText}\n  ${direction} — ${description}\n  Amount: ${money(Number(txn.amount || 0))}\n  Ref: ${txn.reference || "N/A"}`;
      });
      return {
        handled: true,
        reply:
          `Last ${txns.length} transactions — A/C: ${result.maskedAccount || "N/A"}\n` +
          `${lines.join("\n\n")}`,
      };
    };

    const ensureSenderAccount = async (): Promise<string | null> => {
      const sender = await (resolveCustomerAccountTool as any).execute({ phone });
      if (sender?.status === "resolved" && sender.accountNumber) return sender.accountNumber;
      return null;
    };

    const beginTransferConfirmation = async (params: {
      amount: number;
      recipientAccount: string;
      narration?: string;
      startedAt?: string;
    }) => {
      const fromAccount = await ensureSenderAccount();
      if (!fromAccount) {
        return {
          handled: true,
          reply: await composeConversationalReply({
            purpose: "tell the customer their debit account could not be resolved",
            details: {},
          }),
        };
      }

      const recipient = await (lookupCustomerByAccountTool as any).execute({ accountNumber: params.recipientAccount });
      if (!recipient?.found) {
        return {
          handled: true,
          reply: await composeConversationalReply({
            purpose: "tell the customer the recipient account was not found",
            details: { recipientAccount: params.recipientAccount },
          }),
        };
      }

      await setPendingFlow(phone, {
        action: "transfer",
        step: "awaiting_transfer_confirmation",
        data: {
          fromAccount,
          recipientAccount: params.recipientAccount,
          recipientName: recipient.accountName,
          recipientBank: recipient.bankName || "Unknown Bank",
          amount: params.amount,
          narration: params.narration || "Transfer",
        },
        started_at: params.startedAt || new Date().toISOString(),
      });

      return {
        handled: true,
        reply:
          "Transfer summary:\n" +
          `1. Amount: ${money(params.amount)}\n` +
          `2. Recipient name: ${recipient.accountName || "Recipient"}\n` +
          `3. Recipient bank: ${recipient.bankName || "Unknown Bank"}\n` +
          `4. Recipient account: ${maskAccount(params.recipientAccount)}\n` +
          `5. Description: ${params.narration || "Transfer"}\n` +
          "If this looks right, reply naturally to continue, or say cancel if you want to stop.",
      };
    };

    const verifyPinThenOtp = async (
      flowAction: "transfer" | "bill_payment",
      successNextStep: string,
      pin: string | null
    ) => {
      const hasPinResult = await (checkHasPinTool as any).execute({ phone });
      if (!hasPinResult?.found) {
        return {
          handled: true,
          reply: await composeConversationalReply({
            purpose: "tell the customer their phone needs to be verified",
            details: {},
          }),
        };
      }

      if (!hasPinResult?.hasPin) {
        if (!pin) {
          await setPendingFlow(phone, {
            action: flowAction,
            step: "awaiting_new_pin",
            data: { ...(pending?.data || {}), successNextStep },
            started_at: pending?.started_at || new Date().toISOString(),
          });
          return {
            handled: true,
            reply: await humanReply({
              purpose: "ask user to create a pin before continuing money movement flow",
              details: { flowAction },
              requiredSuffix: "Please enter a new 4-digit transaction PIN.",
              fallback: "Please enter a new 4-digit transaction PIN.",
            }),
          };
        }

        const createPin = await (createTransactionPinTool as any).execute({ phone, pin });
        if (!createPin?.created) {
          return { handled: true, reply: createPin?.message || "PIN setup failed. Please try again." };
        }
      } else {
        if (!pin) {
          await setPendingFlow(phone, {
            action: flowAction,
            step: "awaiting_pin",
            data: { ...(pending?.data || {}), successNextStep },
            started_at: pending?.started_at || new Date().toISOString(),
          });
          const pinPrompt =
            flowAction === "transfer"
              ? "🔐 Please enter your 4-digit transaction PIN to authorize this transfer."
              : "🔐 Please enter your 4-digit transaction PIN to authorize this payment.";
          return {
            handled: true,
            reply: await humanReply({
              purpose: "ask user for transaction pin before continuing money movement flow",
              details: { flowAction },
              requiredSuffix: pinPrompt,
              fallback: pinPrompt,
            }),
          };
        }

        const pinResult = await (verifyTransactionPinTool as any).execute({ phone, pin });
        if (!pinResult?.verified) {
          const attemptsRemaining = Number(pinResult?.attemptsRemaining ?? 0);
          if (pinResult?.blocked || attemptsRemaining <= 0) {
            await clearPendingFlow(phone).catch(() => {});
            return {
              handled: true,
              reply: "🔒 Your transaction PIN is locked. Please reset your PIN or contact support.",
            };
          }
          return {
            handled: true,
            reply: `❌ Incorrect PIN. ${attemptsRemaining} attempt(s) remaining.`,
          };
        }
      }

      await (sendPhoneVerificationOtpTool as any).execute({ phone });
      await setPendingFlow(phone, {
        action: flowAction,
        step: "awaiting_otp",
        data: { ...(pending?.data || {}), successNextStep },
        started_at: pending?.started_at || new Date().toISOString(),
      });
      const otpPrompt =
        flowAction === "transfer"
          ? "📲 An OTP has been sent to your registered phone number. Please enter it to authorize the transfer."
          : "📲 An OTP has been sent to your registered phone number. Please enter it to authorize the payment.";
      return {
        handled: true,
        reply: await composeConversationalReply({
          purpose: "tell the customer that the OTP has been sent",
          details: { flowAction },
          requiredSuffix: otpPrompt,
        }),
      };
    };

    if (pending?.action === "balance" || pending?.action === "mini_statement") {
      const step = pending.step;

      const pin = directPin;
      if (step === "awaiting_new_pin") {
        // Inconsistency guard: if customer already has a PIN, redirect to verification
        const pinCheck = await (checkHasPinTool as any).execute({ phone });
        if (pinCheck?.found && pinCheck?.hasPin) {
          await setPendingFlow(phone, {
            action: pending.action,
            step: "awaiting_pin",
            data: pending.data,
            started_at: pending.started_at,
          });
          return {
            handled: true,
            reply: await humanReply({
              purpose: "ask user for existing pin after flow state correction",
              details: { action: pending.action },
              requiredSuffix: "🔐 Please enter your 4-digit transaction PIN to authorize this transaction.",
              fallback: "🔐 Please enter your 4-digit transaction PIN to authorize this transaction.",
            }),
          };
        }

        // First entry of new PIN creation
        if (!pin) {
          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: "🔐 I see you don't have a PIN set up. Please enter a new 4-digit transaction PIN to secure your account.",
            fallback: "🔐 I see you don't have a PIN set up. Please enter a new 4-digit transaction PIN to secure your account.",
          });
        }
        
        // Store the first PIN in pending data and ask for confirmation
        await setPendingFlow(phone, {
          action: pending.action,
          step: "awaiting_new_pin_confirmation",
          data: { ...pending.data, pending_pin: pin },
          started_at: pending.started_at,
        });
        return {
          handled: true,
          reply: await humanReply({
            purpose: "ask the user to confirm the new pin",
            details: { action: pending.action },
            requiredSuffix: "Please re-enter your 4-digit PIN to confirm.",
            fallback: "Please re-enter your 4-digit PIN to confirm.",
          }),
        };
      }

      if (step === "awaiting_new_pin_confirmation") {
        // Second entry - confirm PIN matches first entry
        if (!pin) {
          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: "Please re-enter your 4-digit PIN to confirm.",
            fallback: "Please re-enter your 4-digit PIN to confirm.",
          });
        }
        
        const data = pending.data as any;
        const firstPin = data.pending_pin;

        if (pin !== firstPin) {
          // PINs don't match - restart the process
          await setPendingFlow(phone, {
            action: pending.action,
            step: "awaiting_new_pin",
            data: { intent: pending.data.intent },
            started_at: pending.started_at,
          });
          return { handled: true, reply: "PINs don't match. Please enter a new 4-digit PIN." };
        }

        // PINs match - create the PIN
        const createPin = await (createTransactionPinTool as any).execute({ phone, pin });
        if (!createPin?.created) {
          return { handled: true, reply: createPin?.message || "PIN setup failed. Please try again." };
        }

        // PIN created successfully - clear pending and proceed with transaction
        await clearPendingFlow(phone).catch(() => {});
        
        // Now proceed with the original transaction
        return pending.action === "balance"
          ? await runBalance(pin)
          : await runStatement(pin, Number((pending.data as any)?.statementLimit ?? 10));
      }

      if (step === "awaiting_pin") {
        const pinCheck = await (checkHasPinTool as any).execute({ phone });
        if (pinCheck?.found && !pinCheck?.hasPin) {
          await setPendingFlow(phone, {
            action: pending.action,
            step: "awaiting_new_pin",
            data: { intent: pending.action },
            started_at: pending.started_at,
          });
          return {
            handled: true,
            reply: "🔐 Please enter a new 4-digit transaction PIN to secure your account.",
          };
        }

        // Verify existing PIN
        if (!pin) {
          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: "🔐 Please enter your 4-digit transaction PIN.",
            fallback: "🔐 Please enter your 4-digit transaction PIN.",
          });
        }
        
        const verifyPin = await (verifyTransactionPinTool as any).execute({ phone, pin });
        if (!verifyPin?.verified) {
          const attemptsRemaining = Number(verifyPin?.attemptsRemaining ?? 0);
          if (verifyPin?.blocked || attemptsRemaining <= 0) {
            await clearPendingFlow(phone).catch(() => {});
            return {
              handled: true,
              reply: "🔒 Your transaction PIN is locked. Please reset your PIN or contact support.",
            };
          }
          return {
            handled: true,
            reply: `❌ Incorrect PIN. ${attemptsRemaining} attempt(s) remaining.`,
          };
        }

        // PIN verified - proceed with transaction
        await clearPendingFlow(phone).catch(() => {});
        return pending.action === "balance"
          ? await runBalance(pin)
          : await runStatement(pin, Number((pending.data as any)?.statementLimit ?? 10));
      }
    }

    if (pending?.action === "transfer") {
      const step = pending.step;
      const data = pending.data as any;

      const pin = directPin;
      if (step === "awaiting_transfer_details") {
        if (intentData.cancel) {
          await clearPendingFlow(phone).catch(() => {});
          return { handled: true, reply: "Transfer cancelled." };
        }

        const resolvedAmount = Number(data.amount || 0) || intentData.amount || asAmount(message) || undefined;
        const resolvedRecipientAccount =
          (data.recipientAccount as string | undefined) || intentData.recipientAccount || asAccountNumber(message) || undefined;
        const resolvedNarration =
          asNarration(message) ||
          intentData.narration ||
          (data.narration as string | undefined) ||
          "Transfer";

        if (!resolvedAmount || !resolvedRecipientAccount) {
          await setPendingFlow(phone, {
            action: "transfer",
            step: "awaiting_transfer_details",
            data: {
              ...data,
              amount: resolvedAmount,
              recipientAccount: resolvedRecipientAccount,
              narration: resolvedNarration,
            },
            started_at: pending.started_at,
          });

          return {
            handled: true,
            reply: `${buildTransferDetailsChecklist()}\nIf you want to cancel this request and switch topics, type END.`,
          };
        }

        return beginTransferConfirmation({
          amount: Number(resolvedAmount),
          recipientAccount: String(resolvedRecipientAccount),
          narration: resolvedNarration,
          startedAt: pending.started_at,
        });
      }

      if (step === "awaiting_transfer_confirmation") {
        const decision = await interpretPendingDecision({
          message,
          flowAction: "transfer",
          stage: "summary_confirmation",
          details: {
            amount: money(Number(data.amount || 0)),
            recipient: data.recipientName || "Recipient",
            account: maskAccount(String(data.recipientAccount || "")),
          },
          fallback: intentData,
        });

        if (decision === "cancel") {
          await clearPendingFlow(phone).catch(() => {});
          return { handled: true, reply: await composeConversationalReply({ purpose: "confirm transfer cancellation", details: {} }) };
        }
        if (decision !== "proceed") {
          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: "If you still want to continue with this transfer, just reply naturally and I will proceed. If not, say cancel.",
            fallback: "If you still want to continue with this transfer, just reply naturally and I will proceed. If not, say cancel.",
          });
        }
        return verifyPinThenOtp("transfer", "awaiting_transfer_final_confirmation", pin);
      }

      if (step === "awaiting_new_pin") {
        // Inconsistency guard: if customer already has a PIN, redirect to verification
        const pinCheck = await (checkHasPinTool as any).execute({ phone });
        if (pinCheck?.found && pinCheck?.hasPin) {
          await setPendingFlow(phone, {
            action: "transfer",
            step: "awaiting_pin",
            data: pending.data,
            started_at: pending.started_at,
          });
          return {
            handled: true,
            reply: await humanReply({
              purpose: "ask user for existing pin after flow state correction",
              details: { action: "transfer" },
              requiredSuffix: "🔐 Please enter your 4-digit transaction PIN.",
              fallback: "🔐 Please enter your 4-digit transaction PIN.",
            }),
          };
        }

        // First entry of new PIN creation for transfer
        if (!pin) {
          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: "Please enter a new 4-digit transaction PIN.",
            fallback: "Please enter a new 4-digit transaction PIN.",
          });
        }
        
        // Store the first PIN and ask for confirmation
        await setPendingFlow(phone, {
          action: "transfer",
          step: "awaiting_new_pin_confirmation",
          data: { ...data, pending_pin: pin },
          started_at: pending.started_at,
        });
        return {
          handled: true,
          reply: await humanReply({
            purpose: "ask the user to confirm the new pin for transfer",
            details: { action: "transfer" },
            requiredSuffix: "Please re-enter your 4-digit PIN to confirm.",
            fallback: "Please re-enter your 4-digit PIN to confirm.",
          }),
        };
      }

      if (step === "awaiting_new_pin_confirmation") {
        // Second entry - confirm PIN matches first entry
        if (!pin) {
          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: "Please re-enter your 4-digit PIN to confirm.",
            fallback: "Please re-enter your 4-digit PIN to confirm.",
          });
        }
        
        const firstPin = data.pending_pin;

        if (pin !== firstPin) {
          // PINs don't match - restart
          await setPendingFlow(phone, {
            action: "transfer",
            step: "awaiting_new_pin",
            data: { successNextStep: data.successNextStep },
            started_at: pending.started_at,
          });
          return { handled: true, reply: "PINs don't match. Please enter a new 4-digit PIN." };
        }

        // PINs match - create the PIN
        const createPin = await (createTransactionPinTool as any).execute({ phone, pin });
        if (!createPin?.created) {
          return { handled: true, reply: createPin?.message || "PIN setup failed. Please try again." };
        }

        // PIN created - proceed with verifyPinThenOtp for OTP
        return verifyPinThenOtp("transfer", data.successNextStep || "awaiting_transfer_final_confirmation", pin);
      }

      if (step === "awaiting_pin") {
        if (!pin) {
          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: "🔐 Please enter your 4-digit transaction PIN.",
            fallback: "🔐 Please enter your 4-digit transaction PIN.",
          });
        }
        return verifyPinThenOtp("transfer", data.successNextStep || "awaiting_transfer_final_confirmation", pin);
      }

      if (step === "awaiting_otp") {
        const parsedOtp = intentData.otp || asOtp(message) || undefined;
        if (intentData.resend) {
          await (sendPhoneVerificationOtpTool as any).execute({ phone });
          return { handled: true, reply: "📲 A new OTP has been sent. Please enter it to continue." };
        }
        if (!parsedOtp) {
          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: "Please enter the OTP sent to your registered phone.",
            fallback: "Please enter the OTP sent to your registered phone.",
          });
        }
        const verifyOtp = await (verifyPhoneVerificationOtpTool as any).execute({ phone, otp: parsedOtp });
        if (!verifyOtp?.verified) {
          return { handled: true, reply: verifyOtp?.message || "❌ Incorrect OTP. Please try again." };
        }

        await setPendingFlow(phone, {
          action: "transfer",
          step: "awaiting_transfer_final_confirmation",
          data,
          started_at: pending.started_at,
        });

        return {
          handled: true,
          reply: await composeConversationalReply({
            purpose: "ask the customer to final-confirm the transfer after OTP verification",
            details: {
              amount: money(Number(data.amount || 0)),
              recipient: data.recipientName || "Recipient",
              recipientBank: data.recipientBank || "Unknown Bank",
              account: maskAccount(String(data.recipientAccount || "")),
              otpStatus: "already_verified",
            },
            requiredSuffix:
              "Security check complete. OTP is already verified.\n" +
              `1. Amount: ${money(Number(data.amount || 0))}\n` +
              `2. Recipient name: ${data.recipientName || "Recipient"}\n` +
              `3. Recipient bank: ${data.recipientBank || "Unknown Bank"}\n` +
              `4. Recipient account: ${maskAccount(String(data.recipientAccount || ""))}\n` +
              "If you want me to complete this transfer now, reply naturally. If you want to stop, say cancel.",
          }),
        };
      }

      if (step === "awaiting_transfer_final_confirmation") {
        const decision = await interpretPendingDecision({
          message,
          flowAction: "transfer",
          stage: "final_confirmation",
          details: {
            amount: money(Number(data.amount || 0)),
            recipient: data.recipientName || "Recipient",
            account: maskAccount(String(data.recipientAccount || "")),
          },
          fallback: intentData,
        });

        if (decision === "cancel") {
          await clearPendingFlow(phone).catch(() => {});
          return { handled: true, reply: await composeConversationalReply({ purpose: "confirm transfer cancellation", details: {} }) };
        }
        if (decision !== "proceed") {
          return {
            handled: true,
            reply: await composeConversationalReply({
              purpose: "ask the customer to confirm or cancel the transfer",
              details: {
                amount: money(Number(data.amount || 0)),
                recipient: data.recipientName || "Recipient",
                recipientBank: data.recipientBank || "Unknown Bank",
                account: maskAccount(String(data.recipientAccount || "")),
              },
              requiredSuffix: "Your transfer is ready. Reply naturally if you want me to complete it, or say cancel to stop.",
            }),
          };
        }

        const transfer = await (intraTransferTool as any).execute({
          fromAccount: data.fromAccount,
          toAccount: data.recipientAccount,
          amount: Number(data.amount),
          narration: data.narration || "Transfer",
        });

        if (!transfer?.success) {
          await clearPendingFlow(phone).catch(() => {});
          return { handled: true, reply: transfer?.message || "Transfer failed. Please try again." };
        }

        const receipt = await (generateReceiptTool as any).execute({ reference: transfer.reference });
        await clearPendingFlow(phone).catch(() => {});
        return {
          handled: true,
          reply: receipt?.success
            ? formatTransferReceiptMessage({
                receiptText: receipt.receiptText,
                reference: transfer.reference,
              })
            : await composeConversationalReply({
                purpose: "confirm a successful transfer with the reference number",
                details: { reference: transfer.reference },
              }),
        };
      }
    }

    if (pending?.action === "bill_payment") {
      const step = pending.step;
      const data = pending.data as any;

      const pin = directPin;
      if (step === "awaiting_bill_details") {
        if (intentData.cancel) {
          await clearPendingFlow(phone).catch(() => {});
          return { handled: true, reply: "Payment cancelled." };
        }

        const resolvedAmount = Number(data.amount || 0) || intentData.amount || asAmount(message) || undefined;
        const resolvedBillerName = (data.billerName as string | undefined) || intentData.billerName || undefined;
        const resolvedBillReference =
          (data.billReference as string | undefined) || intentData.billReference || asBillReference(message) || undefined;

        if (!resolvedAmount || !resolvedBillerName || !resolvedBillReference) {
          const missingItems: string[] = [];
          if (!resolvedBillerName) missingItems.push("biller name");
          if (!resolvedBillReference) missingItems.push("smart card/meter/phone/reference number");
          if (!resolvedAmount) missingItems.push("amount");

          await setPendingFlow(phone, {
            action: "bill_payment",
            step: "awaiting_bill_details",
            data: {
              ...data,
              amount: resolvedAmount,
              billerName: resolvedBillerName,
              billReference: resolvedBillReference,
            },
            started_at: pending.started_at,
          });

          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: `Please provide the ${missingItems.join(" and ")} to continue this payment.`,
            fallback: `Please provide the ${missingItems.join(" and ")} to continue this payment.`,
          });
        }

        const valid = await (validateBillerTool as any).execute({ billerName: resolvedBillerName });
        if (!valid?.valid) {
          return { handled: true, reply: valid?.error || "That biller is not supported yet." };
        }

        const fromAccount = await ensureSenderAccount();
        if (!fromAccount) {
          return {
            handled: true,
            reply: await composeConversationalReply({
              purpose: "tell the customer their debit account could not be resolved for bill payment",
              details: {},
            }),
          };
        }

        await setPendingFlow(phone, {
          action: "bill_payment",
          step: "awaiting_bill_confirmation",
          data: {
            fromAccount,
            billerName: valid.normalizedName || resolvedBillerName,
            billReference: resolvedBillReference,
            amount: resolvedAmount,
          },
          started_at: pending.started_at,
        });

        return {
          handled: true,
          reply: await composeConversationalReply({
            purpose: "present the bill payment summary before customer confirmation",
            details: {
              biller: valid.normalizedName || resolvedBillerName,
              idNumber: resolvedBillReference,
              amount: money(Number(resolvedAmount || 0)),
            },
            requiredSuffix: "If these payment details are correct, reply naturally and I will continue. If you want to stop, say cancel.",
          }),
        };
      }

      if (step === "awaiting_bill_confirmation") {
        const decision = await interpretPendingDecision({
          message,
          flowAction: "bill_payment",
          stage: "summary_confirmation",
          details: {
            biller: data.billerName || "Biller",
            amount: money(Number(data.amount || 0)),
            reference: data.billReference || "N/A",
          },
          fallback: intentData,
        });

        if (decision === "cancel") {
          await clearPendingFlow(phone).catch(() => {});
          return { handled: true, reply: await composeConversationalReply({ purpose: "confirm bill payment cancellation", details: {} }) };
        }
        if (decision !== "proceed") {
          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: "If you still want to continue with this payment, just reply naturally and I will proceed. If not, say cancel.",
            fallback: "If you still want to continue with this payment, just reply naturally and I will proceed. If not, say cancel.",
          });
        }
        return verifyPinThenOtp("bill_payment", "awaiting_bill_final_confirmation", pin);
      }

      if (step === "awaiting_new_pin") {
        // Inconsistency guard: if customer already has a PIN, redirect to verification
        const pinCheck = await (checkHasPinTool as any).execute({ phone });
        if (pinCheck?.found && pinCheck?.hasPin) {
          await setPendingFlow(phone, {
            action: "bill_payment",
            step: "awaiting_pin",
            data: pending.data,
            started_at: pending.started_at,
          });
          return {
            handled: true,
            reply: await humanReply({
              purpose: "ask user for existing pin after flow state correction",
              details: { action: "bill_payment" },
              requiredSuffix: "🔐 Please enter your 4-digit transaction PIN.",
              fallback: "🔐 Please enter your 4-digit transaction PIN.",
            }),
          };
        }

        // First entry of new PIN creation for bill payment
        if (!pin) {
          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: "Please enter a new 4-digit transaction PIN.",
            fallback: "Please enter a new 4-digit transaction PIN.",
          });
        }
        
        // Store the first PIN and ask for confirmation
        await setPendingFlow(phone, {
          action: "bill_payment",
          step: "awaiting_new_pin_confirmation",
          data: { ...data, pending_pin: pin },
          started_at: pending.started_at,
        });
        return {
          handled: true,
          reply: await humanReply({
            purpose: "ask the user to confirm the new pin for bill payment",
            details: { action: "bill_payment" },
            requiredSuffix: "Please re-enter your 4-digit PIN to confirm.",
            fallback: "Please re-enter your 4-digit PIN to confirm.",
          }),
        };
      }

      if (step === "awaiting_new_pin_confirmation") {
        // Second entry - confirm PIN matches first entry
        if (!pin) {
          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: "Please re-enter your 4-digit PIN to confirm.",
            fallback: "Please re-enter your 4-digit PIN to confirm.",
          });
        }
        
        const firstPin = data.pending_pin;

        if (pin !== firstPin) {
          // PINs don't match - restart
          await setPendingFlow(phone, {
            action: "bill_payment",
            step: "awaiting_new_pin",
            data: { successNextStep: data.successNextStep },
            started_at: pending.started_at,
          });
          return { handled: true, reply: "PINs don't match. Please enter a new 4-digit PIN." };
        }

        // PINs match - create the PIN
        const createPin = await (createTransactionPinTool as any).execute({ phone, pin });
        if (!createPin?.created) {
          return { handled: true, reply: createPin?.message || "PIN setup failed. Please try again." };
        }

        // PIN created - proceed with verifyPinThenOtp for OTP
        return verifyPinThenOtp("bill_payment", data.successNextStep || "awaiting_bill_final_confirmation", pin);
      }

      if (step === "awaiting_pin") {
        if (!pin) {
          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: "🔐 Please enter your 4-digit transaction PIN.",
            fallback: "🔐 Please enter your 4-digit transaction PIN.",
          });
        }
        return verifyPinThenOtp("bill_payment", data.successNextStep || "awaiting_bill_final_confirmation", pin);
      }

      if (step === "awaiting_otp") {
        const parsedOtp = intentData.otp || asOtp(message) || undefined;
        if (intentData.resend) {
          await (sendPhoneVerificationOtpTool as any).execute({ phone });
          return { handled: true, reply: "📲 A new OTP has been sent. Please enter it to continue." };
        }
        if (!parsedOtp) {
          return remindActiveFlow({
            pendingAction: pending.action,
            currentStep: step,
            nextInstruction: "Please enter the OTP sent to your registered phone.",
            fallback: "Please enter the OTP sent to your registered phone.",
          });
        }
        const verifyOtp = await (verifyPhoneVerificationOtpTool as any).execute({ phone, otp: parsedOtp });
        if (!verifyOtp?.verified) {
          return { handled: true, reply: verifyOtp?.message || "❌ Incorrect OTP. Please try again." };
        }

        await setPendingFlow(phone, {
          action: "bill_payment",
          step: "awaiting_bill_final_confirmation",
          data,
          started_at: pending.started_at,
        });

        return {
          handled: true,
          reply: await composeConversationalReply({
            purpose: "ask the customer to final-confirm the bill payment after OTP verification",
            details: {
              biller: data.billerName,
              amount: money(Number(data.amount || 0)),
            },
            requiredSuffix: "Everything is verified. If you want me to complete this payment now, just say so naturally. If you want to stop, say cancel.",
          }),
        };
      }

      if (step === "awaiting_bill_final_confirmation") {
        const decision = await interpretPendingDecision({
          message,
          flowAction: "bill_payment",
          stage: "final_confirmation",
          details: {
            biller: data.billerName || "Biller",
            amount: money(Number(data.amount || 0)),
            reference: data.billReference || "N/A",
          },
          fallback: intentData,
        });

        if (decision === "cancel") {
          await clearPendingFlow(phone).catch(() => {});
          return { handled: true, reply: await composeConversationalReply({ purpose: "confirm bill payment cancellation", details: {} }) };
        }
        if (decision !== "proceed") {
          return {
            handled: true,
            reply: await composeConversationalReply({
              purpose: "ask the customer to confirm or cancel the bill payment",
              details: {
                biller: data.billerName,
                amount: money(Number(data.amount || 0)),
              },
              requiredSuffix: "Your payment is ready. Reply naturally if you want me to complete it, or say cancel to stop.",
            }),
          };
        }

        const payment = await (billPaymentTool as any).execute({
          fromAccount: data.fromAccount,
          billerName: data.billerName,
          amount: Number(data.amount),
        });
        await clearPendingFlow(phone).catch(() => {});
        return {
          handled: true,
          reply: payment?.success
            ? await composeConversationalReply({
                purpose: "share a successful bill payment summary",
                details: { reference: payment.reference, message: payment.message || "" },
              })
            : payment?.message || "Bill payment failed. Please try again.",
        };
      }
    }

    
    if (action === "balance") {
      return await runBalance(asFourDigits(intentData.pin) ?? undefined);
    }


    if (action === "mini_statement") {
      return await runStatement(asFourDigits(intentData.pin) ?? undefined, asTxnLimit(message) ?? 10);
    }

    if (action === "transfer") {
      const amount = intentData.amount || asAmount(message) || undefined;
      const recipientAccount = intentData.recipientAccount || asAccountNumber(message) || undefined;
      const narration = asNarration(message) || intentData.narration || undefined;
      if (!amount || !recipientAccount) {
        await setPendingFlow(phone, {
          action: "transfer",
          step: "awaiting_transfer_details",
          data: {
            amount,
            recipientAccount,
            narration,
          },
          started_at: new Date().toISOString(),
        });

        return {
          handled: true,
          reply: buildTransferDetailsChecklist(),
        };
      }

      return beginTransferConfirmation({
        amount: Number(amount),
        recipientAccount: String(recipientAccount),
        narration,
      });
    }

    if (action === "bill_payment") {
      const amount = intentData.amount || asAmount(message) || undefined;
      const billerName = intentData.billerName || undefined;
      const billReference = intentData.billReference || asBillReference(message) || undefined;
      if (!amount || !billerName || !billReference) {
        const missingItems: string[] = [];
        if (!billerName) missingItems.push("biller name");
        if (!billReference) missingItems.push("smart card/meter/phone/reference number");
        if (!amount) missingItems.push("amount");

        await setPendingFlow(phone, {
          action: "bill_payment",
          step: "awaiting_bill_details",
          data: {
            amount,
            billerName,
            billReference,
          },
          started_at: new Date().toISOString(),
        });

        return {
          handled: true,
          reply: await composeConversationalReply({
            purpose: "ask the customer for missing bill payment details",
            details: { missing: missingItems.join(" and ") },
            requiredSuffix: `Please provide the ${missingItems.join(" and ")} to continue this payment.`,
          }),
        };
      }

      const valid = await (validateBillerTool as any).execute({ billerName });
      if (!valid?.valid) {
        return { handled: true, reply: valid?.error || "That biller is not supported yet." };
      }

      const fromAccount = await ensureSenderAccount();
      if (!fromAccount) {
        return {
          handled: true,
          reply: await composeConversationalReply({
            purpose: "tell the customer their debit account could not be resolved for bill payment",
            details: {},
          }),
        };
      }

      await setPendingFlow(phone, {
        action: "bill_payment",
        step: "awaiting_bill_confirmation",
        data: {
          fromAccount,
          billerName: valid.normalizedName || billerName,
          billReference,
          amount,
        },
        started_at: new Date().toISOString(),
      });

      return {
        handled: true,
        reply: await composeConversationalReply({
          purpose: "present the bill payment summary before customer confirmation",
          details: {
            biller: valid.normalizedName || billerName,
            idNumber: billReference,
            amount: money(amount),
          },
          requiredSuffix: "If these payment details are correct, reply naturally and I will continue. If you want to stop, say cancel.",
        }),
      };
    }

    return {
      handled: true,
      reply: TRANSACTION_UNKNOWN_REPLY,
    };
  },
});

export const transactionWorkflow = createWorkflow({
  id: "transaction-workflow",
  description: "Conversation-driven workflow executor for all transaction journeys",
  inputSchema: z.object({
    phone: z.string(),
    message: z.string(),
    action: actionSchema.optional(),
  }),
  outputSchema: z.object({
    handled: z.boolean(),
    reply: z.string(),
  }),
})
  .then(understandMessageStep)
  .then(executeConversationFlowStep)
  .commit();

export const TRANSACTION_UNKNOWN_REPLY =
  "Tell me what you want to do, and I will guide you through it. You can ask for your balance, mini statement, a transfer, or a bill payment.";
