/**
 * Transaction PIN Tools
 *
 * Wraps the LOCAL PostgreSQL PIN vault (src/utils/pin-store.ts) for PIN
 * creation and verification — no external banking backend required.
 *
 * Flow — first-time transaction (no PIN set):
 *   1. checkHasPinTool       — discovers PIN is missing
 *   2. createTransactionPinTool — customer provides 4-digit PIN + confirmation
 *   3. Transaction proceeds immediately after PIN is saved
 *
 * Flow — returning user (PIN already set):
 *   1. verifyTransactionPinTool — customer enters 4-digit PIN to authorise transfer
 *   2. If verified: proceed with transaction
 *   3. If wrong: show attempts remaining; after 3 failures the account is temporarily locked
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getLinkedAccount, setAwaitingResume, setAutoResumeNote } from "../../utils/session-state.js";
import {
  hasTransactionPin,
  saveTransactionPin,
  verifyStoredPin,
} from "../../utils/pin-store.js";




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
    const [linked, hasPin] = await Promise.all([
      getLinkedAccount(phone).catch(() => null),
      hasTransactionPin(phone),
    ]);

    if (!linked && !hasPin) {
      return {
        found: false,
        hasPin: false,
        action:
          'STOP: No bank account is linked to this WhatsApp number yet. Tell the customer they must LINK AN ACCOUNT first, then call link-an-account to send the secure Link Account Flow and end your turn.',
        message: "No linked account for this phone number.",
      };
    }

    return {
      found: true,
      hasPin,
      // Explicit next-step instruction for the LLM agent:
      action: hasPin
        ? 'HAS_PIN: Customer already has a transaction PIN. Prompt: "🔐 Please enter your 4-digit transaction PIN." then END YOUR TURN. When they reply with 4 digits, pass pin=<their4Digits> into the balance/statement/transfer tool — those tools verify the PIN internally. DO NOT call verify-transaction-pin separately.'
        : 'NO_PIN: Customer has NO transaction PIN yet. Call set-transaction-pin NOW to send the secure PIN-setup Flow, tell the customer to complete it, then END YOUR TURN. Transactions remain blocked until a PIN exists. Alternatively, if the customer types their desired 4 digits in chat, confirm it and save with create-transaction-pin.',
      message: hasPin ? "Transaction PIN is set." : "No transaction PIN set yet.",
    };
  },
});




// ─── 2. Set Transaction PIN ────────────────────────────────────────────────────

export const setTransactionPinTool = createTool({
  id: "set-transaction-pin",
  description:
    "Generates the WhatsApp UI prompt to set a 4-digit transaction PIN. " +
    "Returns a <flow_action> tag that send-agent-reply.ts resolves to a Meta Flow. " +
    "The flow ID is resolved from the SET_PIN_FLOW_ID env variable.",
  inputSchema: z.object({
    phone: z.string().optional(),
  }),
  outputSchema: z.object({
    status: z.string(),
    ui_template: z.string(),
  }),
  execute: async () => {
    return {
      status: "success",
      ui_template:
        "🔐 To keep your money safe, please create a 4-digit transaction PIN. " +
        "You will use this to confirm transfers.\n\n" +
        "Tap below to set your PIN securely.\n" +
        '<flow_action flow_id="SET_PIN_FLOW" button_text="Set PIN" />',
    };
  },
});



// ─── 2b. Create a transaction PIN inline (chat fallback) ─────────────────────
// Used when the Meta PIN-setup Flow cannot be sent (e.g. SET_PIN_FLOW_ID is not
// configured). The customer simply types their chosen 4-digit PIN in chat and we
// save it to the local PIN vault. This prevents a permanent "PIN not set" loop.

export const createTransactionPinTool = createTool({
  id: "create-transaction-pin",
  description:
    "Save a 4-digit transaction PIN for the customer's WhatsApp number when the secure PIN-setup Flow is unavailable. " +
    "Pass the customer's phone (from context) and the 4-digit PIN they typed. " +
    "Returns saved=true on success. Use this ONLY as a fallback — if set-transaction-pin works, prefer the secure Flow.",
  inputSchema: z.object({
    phone: z.string().describe("Customer's WhatsApp phone number from context"),
    pin: z.string().describe("The 4-digit transaction PIN the customer provided"),
  }),
  outputSchema: z.object({
    saved: z.boolean(),
    message: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ phone, pin }: { phone: string; pin: string }) => {
    const trimmed = String(pin || "").trim();
    if (!/^\d{4}$/.test(trimmed)) {
      return {
        saved: false,
        error: "Invalid PIN — it must be exactly 4 digits (numbers only).",
      };
    }
    const ok = await saveTransactionPin(phone, trimmed);
    return ok
      ? { saved: true, message: "Transaction PIN saved for this number." }
      : { saved: false, error: "Unable to save the PIN right now. Please try again." };
  },
});

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
    const result = await verifyStoredPin(phone, pin);

    if (!result.hasPin) {
      console.log(`[verifyTransactionPinTool] No PIN record for phone=${phone}`);
      return {
        verified: false,
        message: "No transaction PIN found for this number. The customer must create one first.",
        attemptsRemaining: 0,
        blocked: false,
      };
    }

    if (result.blocked) {
      return {
        verified: false,
        message: result.lockedMinutesRemaining
          ? `Account temporarily locked after too many incorrect PIN attempts. Try again in ${result.lockedMinutesRemaining} minute(s).`
          : "Account temporarily locked due to too many incorrect PIN attempts.",
        attemptsRemaining: 0,
        blocked: true,
      };
    }

    console.log(`[verifyTransactionPinTool] Result for phone=${phone}: verified=${result.verified}, attemptsRemaining=${result.attemptsRemaining}`);
    return {
      verified: result.verified,
      message: result.verified ? undefined : `Incorrect PIN. ${result.attemptsRemaining ?? 0} attempt(s) remaining.`,
      attemptsRemaining: result.attemptsRemaining,
      blocked: false,
    };
  },
});
