/**
 * Onboarding Workflow — Revised
 *
 * A deterministic gate-check workflow that:
 *   1. Looks up the customer by phone (MCP: lookup_customer_by_phone)
 *   2. Checks their onboarding status (MCP: get_onboarding_status)
 *   3. If Terms & Conditions not accepted → sends T&C prompt via WhatsApp
 *   4. If T&C accepted but phone not yet verified → sends an OTP via WhatsApp
 *   5. Returns the current onboarding state for the agent to act on
 *
 * ⚠️  This is a SINGLE-EXECUTION workflow (Mastra v1 workflows cannot pause
 * for user input). The multi-turn conversation — user saying "ACCEPT", user
 * entering their OTP code — is handled conversationally by the onboarding-agent
 * using the dedicated onboarding tools (onboarding-tools.ts).
 *
 * Call this workflow at the start of any session to determine the onboarding
 * gate state. The onboarding-agent then drives the conversation from there.
 */
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { callBankingTool } from "../core/mcp/banking-mcp-client.js";
import { sendWhatsAppText } from "../../whatsapp-client.js";

const TERMS_PDF_URL =
  process.env.TERMS_AND_CONDITIONS_URL ??
  "https://www.firstbanknigeria.com/wp-content/uploads/2024/09/Corporate-Account-Opening-Terms-and-Condition.pdf";

// ─── Step 1: Customer Lookup ──────────────────────────────────────────────────

const lookupCustomerStep = createStep({
  id: "lookup-customer",
  description: "Resolve phone number to a bank customer record",
  inputSchema: z.object({
    phone: z.string(),
  }),
  outputSchema: z.object({
    phone: z.string(),
    found: z.boolean(),
    customerId: z.number().optional(),
    isValidated: z.boolean(),
    hasPin: z.boolean(),
    message: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    const { phone } = inputData;

    const result = await callBankingTool<{
      found: boolean;
      customer_id?: number;
      is_validated?: boolean;
      has_pin?: boolean;
      message?: string;
    }>("lookup_customer_by_phone", { phone_number: phone });

    if (!result.found || !result.customer_id) {
      return {
        phone,
        found: false,
        isValidated: false,
        hasPin: false,
        message: result.message ?? "Customer not found in the system.",
      };
    }

    return {
      phone,
      found: true,
      customerId: result.customer_id,
      isValidated: result.is_validated ?? false,
      hasPin: result.has_pin ?? false,
    };
  },
});

// ─── Step 2: Onboarding Status Check ─────────────────────────────────────────

const checkOnboardingStep = createStep({
  id: "check-onboarding-status",
  description: "Fetch T&C acceptance and phone-verification flags for the customer",
  inputSchema: z.object({
    phone: z.string(),
    found: z.boolean(),
    customerId: z.number().optional(),
    isValidated: z.boolean(),
    hasPin: z.boolean(),
    message: z.string().optional(),
  }),
  outputSchema: z.object({
    phone: z.string(),
    found: z.boolean(),
    customerId: z.number().optional(),
    hasPin: z.boolean(),
    termsAccepted: z.boolean(),
    phoneVerified: z.boolean(),
    isFullyOnboarded: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    const { phone, found, customerId, hasPin } = inputData;

    if (!found || !customerId) {
      return { phone, found: false, hasPin: false, termsAccepted: false, phoneVerified: false, isFullyOnboarded: false };
    }

    const result = await callBankingTool<{
      success: boolean;
      terms_accepted?: boolean;
      phone_verified?: boolean;
    }>("get_onboarding_status", { customer_id: customerId });

    const termsAccepted = result.terms_accepted ?? false;
    const phoneVerified = result.phone_verified ?? false;

    return {
      phone,
      found: true,
      customerId,
      hasPin,
      termsAccepted,
      phoneVerified,
      isFullyOnboarded: termsAccepted && phoneVerified,
    };
  },
});

// ─── Step 3: Send Appropriate Onboarding Prompt ───────────────────────────────

const sendOnboardingPromptStep = createStep({
  id: "send-onboarding-prompt",
  description: "Send a T&C prompt or OTP based on the customer's current onboarding state",
  inputSchema: z.object({
    phone: z.string(),
    found: z.boolean(),
    customerId: z.number().optional(),
    hasPin: z.boolean(),
    termsAccepted: z.boolean(),
    phoneVerified: z.boolean(),
    isFullyOnboarded: z.boolean(),
  }),
  outputSchema: z.object({
    phone: z.string(),
    found: z.boolean(),
    customerId: z.number().optional(),
    hasPin: z.boolean(),
    termsAccepted: z.boolean(),
    phoneVerified: z.boolean(),
    isFullyOnboarded: z.boolean(),
    /** What prompt action was taken this execution */
    promptAction: z.enum(["none", "not_registered", "terms_prompt", "otp_sent"]),
    otpCode: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    const { phone, found, customerId, termsAccepted, phoneVerified, isFullyOnboarded, hasPin } = inputData;
    const bankName = process.env.BANK_NAME ?? "First Bank Nigeria";
    const botName = process.env.BOT_NAME ?? "FBN Banking Assistant";

    // Customer not in database
    if (!found) {
      await sendWhatsAppText(
        phone,
        `👋 Welcome to *${bankName}*!\n\n` +
          `It looks like your number isn't linked to a ${bankName} account yet.\n\n` +
          `To get started:\n` +
          `1️⃣ Visit any ${bankName} branch to open or link your account\n` +
          `2️⃣ Use *894# to link your number\n\n` +
          `Once linked, come back here for full WhatsApp Banking!`,
      );
      return { ...inputData, promptAction: "not_registered" as const };
    }

    // Already fully onboarded
    if (isFullyOnboarded) {
      return { ...inputData, promptAction: "none" as const };
    }

    // Terms not yet accepted — send T&C prompt
    if (!termsAccepted) {
      await sendWhatsAppText(
        phone,
        `👋 *Welcome to ${bankName} WhatsApp Banking!*\n\n` +
          `I'm ${botName}, your AI banking assistant.\n\n` +
          `Before you can use our services, please read and accept our *Terms & Conditions*.\n\n` +
          `📄 ${TERMS_PDF_URL}\n\n` +
          `Reply *ACCEPT* to agree and activate your WhatsApp Banking.\n` +
          `Reply *DECLINE* if you do not wish to proceed.\n\n` +
          `_Your data is protected under NDPR regulations._`,
      );
      return { ...inputData, promptAction: "terms_prompt" as const };
    }

    // Terms accepted but phone not verified — send OTP
    if (!phoneVerified) {
      const otpResult = await callBankingTool<{
        success: boolean;
        otp_code?: string;
        message?: string;
      }>("send_verification_otp", { phone_number: phone });

      if (otpResult.success) {
        await sendWhatsAppText(
          phone,
          `✅ *Terms Accepted — Thank you!*\n\n` +
            `📱 We've sent a *verification code* to your registered phone number.\n\n` +
            `Please enter the *4-digit code* to verify your phone number and activate your account.\n\n` +
            `⏱️ Code is valid for 10 minutes. Do NOT share with anyone.`,
        );
        return {
          ...inputData,
          promptAction: "otp_sent" as const,
          otpCode: otpResult.otp_code,
        };
      }

      await sendWhatsAppText(
        phone,
        `⚠️ We couldn't send the verification code right now. Please try again in a moment.`,
      );
      return { ...inputData, promptAction: "otp_sent" as const };
    }

    return { ...inputData, promptAction: "none" as const };
  },
});

// ─── Workflow Export ──────────────────────────────────────────────────────────

export const onboardingWorkflow = createWorkflow({
  id: "onboarding-workflow",
  description:
    "Gate-check workflow: looks up the customer, checks T&C + phone-verification status, " +
    "and sends the appropriate prompt (T&C or OTP). " +
    "Returns the full onboarding state so the calling agent can drive the conversation.",
  inputSchema: z.object({
    phone: z.string().describe("Customer WhatsApp phone number"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    customerId: z.number().optional(),
    hasPin: z.boolean(),
    termsAccepted: z.boolean(),
    phoneVerified: z.boolean(),
    isFullyOnboarded: z.boolean(),
    promptAction: z.enum(["none", "not_registered", "terms_prompt", "otp_sent"]),
    otpCode: z.string().optional(),
  }),
})
  .then(lookupCustomerStep)
  .then(checkOnboardingStep)
  .then(sendOnboardingPromptStep)
  .commit();
