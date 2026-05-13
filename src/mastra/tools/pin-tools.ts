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
    "ALWAYS pass the customer's phone number extracted from the system context — " +
    "look for the text 'Customer phone:' and take the number that follows it. NEVER ask the customer for their phone. " +
    "Returns found (whether the customer exists) and hasPin (whether PIN is set). " +
    "CRITICAL: After calling this tool, READ the 'action' field and follow it exactly. " +
    "If found=false: inform the customer their phone is not registered and stop. " +
    "If found=true: the action field will instruct you to STOP and send a PIN prompt. " +
    "DO NOT call get-balance, get-mini-statement, or any transaction tool in the SAME turn as check-has-pin. " +
    "You MUST send a PIN prompt to the customer and wait for their next message before proceeding.",
  inputSchema: z.object({
    phone: z.string().describe("Customer's WhatsApp phone number"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    hasPin: z.boolean(),
    action: z.string().describe("Next action: VERIFY_PIN or CREATE_PIN"),
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
      hasPin: result.has_pin ?? false,
      // Explicit next-step instruction for the LLM agent:
      action: result.found === false
        ? 'STOP: phone not registered. Respond: "Your number is not registered with First Bank Nigeria. Please visit any branch or dial *894# to link your account." then end.'
        : result.has_pin
          ? 'STOP_AND_PROMPT: Customer has a PIN. Send EXACTLY: "🔐 Please enter your 4-digit transaction PIN." then END YOUR TURN. In the NEXT TURN when customer sends 4 digits: call get-balance(phone=contextPhone, pin=thatPIN) or get-mini-statement(phone=contextPhone, pin=thatPIN) — those tools verify the PIN internally. DO NOT call verify-transaction-pin for balance/statement.'
          : 'STOP_AND_PROMPT: Customer has no PIN. Follow PIN CREATION FLOW exactly. STEP 1: Send EXACTLY "Please enter a new 4-digit transaction PIN." then END THIS TURN. DO NOT call create-transaction-pin, send-phone-verification-otp, or any other tool yet. Wait for the customer to reply with 4 digits. Do NOT proceed with the original request until PIN creation is complete (create-transaction-pin returns created=true).',
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
    "Only call this AFTER the customer has entered their desired PIN AND confirmed it a second time and both entries match. " +
    "Call this tool EXACTLY ONCE per PIN creation flow — NEVER call it twice. " +
    "If the two PIN entries do not match, do NOT call this tool — ask the customer to re-enter. " +
    "When this tool returns created=true, the flow is COMPLETE. Do NOT call it again. " +
    "Respond immediately with success and continue with the original transaction. " +
    "Pass the customer's WhatsApp phone number (from context) — the tool resolves the customer ID internally. " +
    "Returns created=true on success, created=false with errorCode on failure.",
  inputSchema: z.object({
    phone: z.string().describe("Customer's WhatsApp phone number from context — used to resolve the correct customer ID internally"),
    pin: z.string().length(4).regex(/^\d{4}$/, "Must be exactly 4 digits").describe("The 4-digit PIN to save"),
  }),
  outputSchema: z.object({
    created: z.boolean(),
    message: z.string().optional(),
    errorCode: z.string().nullable().optional(),
  }),
  execute: async ({ phone, pin }: { phone: string; pin: string }) => {
    // Always resolve customerId from phone — never trust LLM-supplied IDs
    const customer = await callBankingTool<{ found: boolean; customer_id?: number }>("lookup_customer_by_phone", { phone_number: phone });
    if (!customer.found || !customer.customer_id) {
      console.log(`[createTransactionPinTool] Customer not found for phone=${phone}`);
      return { created: false, message: "Customer not found", errorCode: "CUSTOMER_NOT_FOUND" };
    }
    const customerId = customer.customer_id;
    console.log(`[createTransactionPinTool] Creating PIN for phone=${phone} → customerId=${customerId}`);
    const result = await callBankingTool<{
      success: boolean;
      message?: string;
      error_code?: string;
    }>("set_transaction_pin", { customer_id: customerId, new_pin: pin });

    const finalResult = {
      created: result.success,
      message: result.message,
      errorCode: result.error_code ?? null,
    };
    console.log(`[createTransactionPinTool] Result for customerId=${customerId}: created=${finalResult.created}, message=${finalResult.message}`);
    return finalResult;
  },
});

// ─── 3. Verify an existing PIN for a transaction ─────────────────────────────

export const verifyTransactionPinTool = createTool({
  id: "verify-transaction-pin",
  description:
    "Verify the customer's 4-digit transaction PIN before executing a money-movement. " +
    "Call this AFTER the customer enters their PIN. " +
    "Pass the customer's WhatsApp phone number (from context) — the tool resolves the customer ID internally. " +
    "Returns verified=true on success, or verified=false with attemptsRemaining and blocked flag. " +
    "If blocked=true, stop the transaction — the account is temporarily PIN-locked.",
  inputSchema: z.object({
    phone: z.string().describe("Customer's WhatsApp phone number from context — used to resolve the correct customer ID internally"),
    pin: z.string().describe("The 4-digit PIN entered by the customer. Always ask, don't assume it from history"),
  }),
  outputSchema: z.object({
    verified: z.boolean(),
    message: z.string().optional(),
    attemptsRemaining: z.number().optional(),
    blocked: z.boolean(),
  }),
  execute: async ({ phone, pin }: { phone: string; pin: string }) => {
    // Always resolve customerId from phone — never trust LLM-supplied IDs
    const customer = await callBankingTool<{ found: boolean; customer_id?: number }>("lookup_customer_by_phone", { phone_number: phone });
    
    if (!customer.found || !customer.customer_id) {
      console.log(`[verifyTransactionPinTool] Customer not found for phone=${phone}`);
      return { verified: false, message: "Customer not found", attemptsRemaining: 0, blocked: false };
    }
    const customerId = customer.customer_id;
    console.log(`[verifyTransactionPinTool] Verifying PIN for phone=${phone} → customerId=${customerId}`);
    const result = await callBankingTool<{
      success: boolean;
      message?: string;
      attempts_remaining?: number;
      blocked?: boolean;
    }>("verify_pin", { customer_id: customerId, pin });

    const finalResult = {
      verified: result.success,
      message: result.message,
      attemptsRemaining: result.attempts_remaining,
      blocked: result.blocked ?? false,
    };

    console.log(`[verifyTransactionPinTool] Result for customerId=${customerId}: verified=${finalResult.verified}, attemptsRemaining=${finalResult.attemptsRemaining}, blocked=${finalResult.blocked}`);
    return finalResult;
  },
});
