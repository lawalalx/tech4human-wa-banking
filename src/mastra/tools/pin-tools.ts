/**
 * Transaction PIN Tools
 *
 * Wraps mcp_service_fb PIN endpoints for PIN creation and verification.
 *
 * Flow — first-time transaction (no PIN set):
 *   1. checkHasPinTool       — discovers PIN is missing
 *   2. createTransactionPinTool — customer provides 4-digit PIN + confirmation
 *   3. Transaction proceeds immediately after PIN is saved
 *
 * Flow — returning user (PIN already set):
 *   1. verifyTransactionPinTool — customer enters 4-digit PIN to authorise transfer
 *   2. If verified: proceed with transaction
 *   3. If wrong: show attempts remaining; after 3 failures the account is temporarily blocked
 */
import { createTool } from "@mastra/core/tools";
import { custom, z } from "zod";
import { callBankingTool } from "../core/mcp/banking-mcp-client.js";




// ─── 1. Check if customer has a PIN ───────────────────────────────────────────

export const checkHasPinTool = createTool({
  id: "check-has-pin",
  description:
    "Check whether the customer has already set a transaction PIN. " +
    "ALWAYS pass the customer's WhatsApp phone number from the system context message " +
    "(format: 'Customer phone: +234XXXXXXXXXX'). NEVER ask the customer for their phone — use it from context. " +
    "Returns customerId (needed for create/verify calls) and hasPin flag. " +
    "Call this before initiating any money-movement transaction. " +
    "If hasPin=false, guide the customer through PIN creation before proceeding.",
  inputSchema: z.object({
    phone: z.string().describe("Customer's WhatsApp phone number"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    customerId: z.number().optional(),
    hasPin: z.boolean(),
    action: z.string().describe("Next action for the flow based on PIN status"),
    message: z.string().optional(),
  }),
  execute: async ({ phone }: { phone: string }) => {
    console.log(`[checkHasPinTool] Checking PIN status for phone=${phone}`);
    const result = await callBankingTool<{
      found: boolean;
      customer_id?: number;
      has_pin?: boolean;
      message?: string;
    }>("lookup_customer_by_phone", { phone_number: phone });

    const finalResult = {
      found: result.found ?? false,
      customerId: result.customer_id,
      hasPin: result.has_pin ?? false,  
      action: result.has_pin ? 'VERIFY_PIN' : 'CREATE_PIN',
      message: result.message,
    };
    console.log(`[checkHasPinTool] PIN status for phone=${phone}: found=${finalResult.found}`);
    return finalResult;
  },
});

// ─── 2. Create (save) a new transaction PIN ───────────────────────────────────

export const createTransactionPinTool = createTool({
  id: "create-transaction-pin",
  description:
    "Save a new 4-digit transaction PIN for the customer. " +
    "Only call this AFTER the customer has entered their desired PIN and confirmed it matches. " +
    "If the two PIN entries do not match, do NOT call this tool — ask the customer to re-enter. " +
    "Returns success/failure and any validation error message.",
  inputSchema: z.object({
    customerId: z.number().describe("Customer ID. You must call lookup_customer_by_phone to get this"),
    pin: z.string().length(4).regex(/^\d{4}$/, "Must be exactly 4 digits").describe("The 4-digit PIN to save"),
  }),
  outputSchema: z.object({
    created: z.boolean(),
    message: z.string().optional(),
    errorCode: z.string().optional(),
  }),
  execute: async ({ customerId, pin }: { customerId: number; pin: string }) => {

    console.log(`[createTransactionPinTool] Attempting to create PIN for customerId=${customerId}`);
    const result = await callBankingTool<{
      success: boolean;
      message?: string;
      error_code?: string;
    }>("set_transaction_pin", { customer_id: customerId, new_pin: pin });

    const finalResult = {
      created: result.success,
      message: result.message,
      errorCode: result.error_code,
    };
    console.log(`[createTransactionPinTool] PIN creation result for customerId=${customerId}: created=${finalResult.created}, message=${finalResult.message}, errorCode=${finalResult.errorCode}`);
    return finalResult;
  },
});

// ─── 3. Verify an existing PIN for a transaction ─────────────────────────────

export const verifyTransactionPinTool = createTool({
  id: "verify-transaction-pin",
  description:
    "Verify the customer's 4-digit transaction PIN before executing a money-movement. " +
    "Call this AFTER the customer enters their PIN. " +
    "STEP 1: You must call 'lookup-customer-by-phone' again to get customerId BEFORE using this tool. " +
    "Returns verified=true on success, or verified=false with attemptsRemaining and blocked flag. " +
    "If blocked=true, stop the transaction — the account is temporarily PIN-locked.",
  inputSchema: z.object({
    customerId: z.number().describe("Customer ID. You must call lookup_customer_by_phone to get this"),
    pin: z.string().describe("The 4-digit PIN entered by the customer. Always ask, don't assume it from history"),
  }),
  outputSchema: z.object({
    verified: z.boolean(),
    message: z.string().optional(),
    attemptsRemaining: z.number().optional(),
    blocked: z.boolean(),
  }),
  execute: async ({ customerId, pin }: { customerId: number; pin: string }) => {
    console.log(`[verifyTransactionPinTool] Verifying PIN for customerId=${customerId}`);
    const result = await callBankingTool<{
      success: boolean;
      message?: string;
      attempts_remaining?: number;
      blocked?: boolean;
    }>("verify_pin", { customer_id: customerId, pin });

    const finalResult =  {
      verified: result.success,
      message: result.message,
      attemptsRemaining: result.attempts_remaining,
      blocked: result.blocked ?? false,
    };

    console.log(`[verifyTransactionPinTool] Verification result for customerId=${customerId}: verified=${finalResult.verified}, attemptsRemaining=${finalResult.attemptsRemaining}, blocked=${finalResult.blocked}`);
    return finalResult;
  },
});
