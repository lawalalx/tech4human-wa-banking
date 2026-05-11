/**
 * Onboarding MCP Tools
 *
 * Wraps mcp_service_fb tools for the full T&C → phone-OTP onboarding gate.
 * These are used by the onboarding-agent to drive the first-time-user flow.
 *
 * Flow:
 *   1. lookupCustomerForOnboardingTool   — resolve phone → customer_id + has_pin + is_validated
 *   2. checkOnboardingStatusTool         — terms_accepted, phone_verified
 *   3. acceptTermsAndConditionsTool      — MCP update_onboarding_status(terms_accepted=true)
 *   4. sendPhoneVerificationOtpTool      — MCP send_verification_otp (dev returns otp_code)
 *   5. verifyPhoneOtpTool                — compare entered OTP, then mark phone verified
 *   6. markPhoneVerifiedTool             — MCP update_onboarding_status(phone_verified=true)
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { callBankingTool } from "../core/mcp/banking-mcp-client.js";


// ─── 1. Lookup Customer ───────────────────────────────────────────────────────
export const lookupCustomerForOnboardingTool = createTool({
  id: "lookup-customer-for-onboarding",
  description:
    "Look up a customer by phone number. Returns customer_id, is_validated, has_pin, found. " +
    "Always call this first in any onboarding session to resolve the customer_id. " +
    "If found=false the customer is not yet registered — direct them to visit a branch.",
  inputSchema: z.object({
    phone: z.string().describe("Customer WhatsApp number, e.g. 2348012345678"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    customerId: z.number().optional(),
    isValidated: z.boolean(),
    hasPin: z.boolean(),
    message: z.string().optional(),
  }),
  execute: async ({ phone }: { phone: string }) => {
    const result = await callBankingTool<{
      found: boolean;
      customer_id?: number;
      is_validated?: boolean;
      has_pin?: boolean;
      message?: string;
    }>("lookup_customer_by_phone", { phone_number: phone });

    return {
      found: result.found ?? false,
      customerId: result.customer_id,
      isValidated: result.is_validated ?? false,
      hasPin: result.has_pin ?? false,
      message: result.message,
    };
  },
});

// ─── 2. Check Onboarding Status ───────────────────────────────────────────────

export const checkOnboardingStatusTool = createTool({
  id: "check-onboarding-status",
  description:
    "Check whether a customer has accepted the Terms & Conditions and verified their phone. " +
    "Call this at the start of any session to decide whether onboarding steps remain. " +
    "Returns terms_accepted, phone_verified, is_validated.",
  inputSchema: z.object({
    customerId: z.number().describe("Customer ID. You must call lookup_customer_by_phone to get this"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    customerId: z.number().optional(),
    termsAccepted: z.boolean(),
    phoneVerified: z.boolean(),
    isValidated: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async ({ customerId }: { customerId: number }) => {
    const result = await callBankingTool<{
      success: boolean;
      customer_id?: number;
      terms_accepted?: boolean;
      phone_verified?: boolean;
      message?: string;
    }>("get_onboarding_status", { customer_id: customerId });

    if (!result.success) {
      return {
        found: false,
        termsAccepted: false,
        phoneVerified: false,
        isValidated: false,
        error: result.message,
      };
    }

    const terms = result.terms_accepted ?? false;
    const phone = result.phone_verified ?? false;

    console.log(`\n\n[checkOnboardingStatusTool] Onboarding status for customerId=${customerId}: terms=${terms}, phone=${phone}`);

    return {
      found: true,
      customerId: result.customer_id,
      termsAccepted: terms,
      phoneVerified: phone,
      isValidated: terms && phone,
    };
  },
});

// ─── 3. Accept Terms & Conditions ────────────────────────────────────────────

export const acceptTermsAndConditionsTool = createTool({
  id: "accept-terms-and-conditions",
  description:
    "Record that the customer has explicitly accepted the WhatsApp Banking Terms & Conditions. " +
    "ONLY call this after the customer has replied YES, ACCEPT, or clearly consented. " +
    "Never call without explicit confirmation.",
  inputSchema: z.object({
    customerId: z.number().describe("Customer ID gotten calling lookup_customer_by_phone"),
  }),
  outputSchema: z.object({
    accepted: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async ({ customerId }: { customerId: number }) => {
    const result = await callBankingTool<{
      success: boolean;
      message?: string;
    }>("update_onboarding_status", {
      customer_id: customerId,
      field: "terms_accepted",
      value: true,
    });

    return {
      accepted: result.success,
      error: result.success ? undefined : result.message,
    };
  },
});

// ─── 4. Send Phone Verification OTP ──────────────────────────────────────────

export const sendPhoneVerificationOtpTool = createTool({
  id: "send-phone-verification-otp",
  description:
    "Send a verification OTP to the customer's WhatsApp/phone number to confirm ownership. " +
    "Call this after Terms & Conditions are accepted. " +
    "Returns otpCode (store internally — use it to compare against the customer's reply). " +
    "In production, the OTP is sent silently; only the otpCode is returned for verification.",
  inputSchema: z.object({
    phone: z.string().describe("Customer phone number (e.g. 2348012345678)"),
  }),
  outputSchema: z.object({
    sent: z.boolean(),
    message: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ phone }: { phone: string }) => {
    const result = await callBankingTool<{
      success: boolean;
      message?: string;
    }>("send_verification_otp", { phone_number: phone });

    return {
      sent: result.success,
      message: result.message,
    };
  },
});
  

export const verifyPhoneVerificationOtpTool = createTool({
  id: "verify-phone-verification-otp",
  description:
    "Verify an OTP entered by the customer." +
    "STEP 1: You must call 'lookup-customer-by-phone' again to get customerId BEFORE using this tool. " +
    "Returns verified=true if OTP is correct, or verified=false with message if incorrect or expired.",
  inputSchema: z.object({
    customerId: z.number().describe("Customer ID gotten calling lookup_customer_by_phone"),
    otp: z.number().describe("The 4-digit OTP entered by the customer"),
  }),
  outputSchema: z.object({
    verified: z.boolean(),
    found: z.boolean(),
    message: z.string().optional(),
  }),
  execute: async ({ customerId, otp }: { customerId: number; otp: number }) => {
    console.log(`\n\n[verifyPhoneVerificationOtpTool] Verifying OTP for customerId=${customerId}, otp=${otp}`);
    const result = await callBankingTool<{
      success: boolean;
      found: boolean;
      message?: string;
    }>("verify_otp", { customer_id: customerId, otp_code: otp });

    console.log(`[verifyPhoneVerificationOtpTool] OTP verification result for customerId=${customerId}: success=${result.success}, found=${result.found}, message=${result.message}`);
    return {
      verified: result.success,
      found: result.found,
      message: result.message,

    };
  },
});

// ─── 5. Mark Phone Verified ───────────────────────────────────────────────────
export const markPhoneVerifiedTool = createTool({
  id: "mark-phone-verified",
  description:
    "Mark the customer's phone as verified after they have correctly entered the OTP. " +
    "This completes onboarding and activates their WhatsApp Banking account. " +
    "Only call this AFTER you have confirmed the customer's entered code matches the sent OTP.",
  inputSchema: z.object({
    customerId: z.number().describe("Customer ID. You must call lookup_customer_by_phone to get this"),
  }),
  outputSchema: z.object({
    verified: z.boolean(),
    isNowFullyOnboarded: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async ({ customerId }: { customerId: number }) => {
    const result = await callBankingTool<{
      success: boolean;
      message?: string;
    }>("update_onboarding_status", {
      customer_id: customerId,
      field: "phone_verified",
      value: true,
    });

    return {
      verified: result.success,
      isNowFullyOnboarded: result.success,
      error: result.success ? undefined : result.message,
    };
  },
});
