/**
 * PIN Check Workflow
 *
 * A single-execution Mastra workflow that checks whether a customer has a
 * transaction PIN set, and sends a creation prompt if they don't.
 *
 * This workflow is a *gate check* — it runs in one shot (no user input pause).
 * The multi-turn PIN creation conversation is then handled by the
 * transaction-agent using createTransactionPinTool after the workflow returns.
 *
 * Trigger: transaction-agent calls this workflow before initiating any
 *          money-movement (transfer, bill payment, etc.).
 *
 * Return contract:
 *   requiresPinCreation = true  → agent must collect and save a 4-digit PIN first
 *   requiresPinCreation = false, hasPin = true  → agent should ask for PIN verification
 *   found = false               → customer not registered; show branch visit message
 */
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { callBankingTool } from "../core/mcp/banking-mcp-client.js";
import { sendWhatsAppText } from "../../whatsapp-client.js";

// ─── Step 1: Lookup customer & check PIN status ───────────────────────────────

const checkPinExistsStep = createStep({
  id: "check-pin-exists",
  description: "Lookup customer by phone and determine whether a transaction PIN is already set",
  inputSchema: z.object({
    phone: z.string().describe("Customer WhatsApp number"),
  }),
  outputSchema: z.object({
    phone: z.string(),
    found: z.boolean(),
    customerId: z.number().optional(),
    hasPin: z.boolean(),
    isValidated: z.boolean(),
    message: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    const { phone } = inputData;

    const result = await callBankingTool<{
      found: boolean;
      customer_id?: number;
      has_pin?: boolean;
      is_validated?: boolean;
      message?: string;
    }>("lookup_customer_by_phone", { phone_number: phone });

    return {
      phone,
      found: result.found ?? false,
      customerId: result.customer_id,
      hasPin: result.has_pin ?? false,
      isValidated: result.is_validated ?? false,
      message: result.message,
    };
  },
});

// ─── Step 2: Send PIN creation prompt if needed ───────────────────────────────

const sendPinCreationPromptStep = createStep({
  id: "send-pin-creation-prompt",
  description: "Send a PIN creation prompt to the customer if no PIN is set",
  inputSchema: z.object({
    phone: z.string(),
    found: z.boolean(),
    customerId: z.number().optional(),
    hasPin: z.boolean(),
    isValidated: z.boolean(),
    message: z.string().optional(),
  }),
  outputSchema: z.object({
    phone: z.string(),
    found: z.boolean(),
    customerId: z.number().optional(),
    hasPin: z.boolean(),
    requiresPinCreation: z.boolean(),
    promptSent: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    const { phone, found, customerId, hasPin } = inputData;

    if (!found) {
      return { phone, found: false, hasPin: false, requiresPinCreation: false, promptSent: false };
    }

    if (hasPin) {
      // PIN already exists — transaction-agent will prompt for PIN verification
      return { phone, found: true, customerId, hasPin: true, requiresPinCreation: false, promptSent: false };
    }

    // No PIN — send prompt and signal that creation is required
    await sendWhatsAppText(
      phone,
      "🔐 *Set Up Your Transaction PIN*\n\n" +
        "To keep your account secure, you need a 4-digit transaction PIN before sending money.\n\n" +
        "This PIN will be required every time you make a transfer or payment.\n\n" +
        "Please create your PIN:\n" +
        "Enter a *4-digit number* (digits only, no spaces or letters).\n\n" +
        "⚠️ *Never share your PIN with anyone* — not even bank staff.",
    );

    return { phone, found: true, customerId, hasPin: false, requiresPinCreation: true, promptSent: true };
  },
});

// ─── Workflow Definition ──────────────────────────────────────────────────────

export const pinCheckWorkflow = createWorkflow({
  id: "pin-check-workflow",
  description:
    "Check whether a customer has a transaction PIN set. " +
    "Sends a creation prompt if not. Returns requiresPinCreation flag for agent routing.",
  inputSchema: z.object({
    phone: z.string().describe("Customer WhatsApp phone number"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    customerId: z.number().optional(),
    hasPin: z.boolean(),
    requiresPinCreation: z.boolean(),
    promptSent: z.boolean(),
  }),
})
  .then(checkPinExistsStep)
  .then(sendPinCreationPromptStep)
  .commit();
