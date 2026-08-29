/**
 * Terms & Conditions + Account Linking + PIN Setup Tools (SUPERVISOR-LEVEL)
 *
 * The supervisor calls `acceptTermsAndConditionsTool` as its VERY FIRST action
 * for every customer -- before routing to any sub-agent.
 *
 * State persistence:
 *   - Local session state: `customer_sessions.context.service_terms_accepted`
 *   - MCP (when reachable): `update_onboarding_status(customer_id, 'terms_accepted', true)`
 *
 * `addNewAccountTool` and `setTransactionPinTool` emit `<flow_action>` tags that
 * `send-agent-reply.ts` resolves to real Meta Flow messages.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  lookupCustomerByPhone,
  getOnboardingStatus,
  updateOnboardingStatus,
} from "../../services/local-customer-service.js";
import {
  hasAcceptedServiceTerms,
  setServiceTermsAccepted,
} from "../../utils/session-state.js";

const bankName = process.env.BANK_NAME || "First Bank Nigeria";
const supportPhone = process.env.SUPPORT_PHONE || "+2348001234567";

// The exact T&C template -- matches the spec in banking-supervisor.ts instructions.
const TNC_TEMPLATE = [
  "👋 Welcome to *", bankName, "* WhatsApp Banking!",
  "",
  "Before we begin, please read and accept our service terms:",
  "",
  "📜 *WhatsApp Banking — Terms of Use*",
  "",
  "✅ This service is provided by ", bankName, ", powered by Tech4Human AI.",
  "✅ You must be an existing ", bankName, " customer or opening a new account.",
  "✅ All transactions are secured with PIN + OTP verification.",
  "✅ Your data is handled per Nigeria's NDPR and CBN data guidelines.",
  "✅ Never share your PIN or OTP with anyone — including bank staff.",
  "✅ Standard network data rates may apply.",
  "",
  "📄 Full Terms: https://www.firstbanknigeria.com/terms",
  "",
  "Do you *ACCEPT* to continue?",
  '<options>[{\"id\":\"accept\",\"title\":\"Accept & Continue\"},{\"id\":\"decline\",\"title\":\"Decline\"}]</options>',
].join("\n");

// ─── 1. Accept Terms & Conditions ─────────────────────────────────────────────

export const acceptTermsAndConditionsTool = createTool({
  id: "accept-terms-and-condition",
  description:
    "The SUPERVISOR must call this tool FIRST for every customer. " +
    "Use action='check' to verify whether T&C are already accepted " +
    "(returns the T&C welcome template with Accept/Reject buttons if not yet accepted). " +
    "Use action='accept' ONLY after the customer has explicitly said YES/ACCEPT/CONTINUE " +
    "(saves the acceptance record against the phone number). " +
    "Pass the customer's WhatsApp phone number from system context.",
  inputSchema: z.object({
    action: z
      .enum(["check", "accept"])
      .describe('Use "check" to verify status; "accept" to record acceptance.'),
    phone: z.string().describe("The customer phone number from system context."),
  }),
  outputSchema: z.object({
    status: z.enum(["success", "pending"]),
    accepted: z.boolean().optional(),
    ui_template: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ action, phone }: { action: "check" | "accept"; phone: string }) => {
    if (action === "check") {
      const locallyAccepted = await hasAcceptedServiceTerms(phone);
      if (locallyAccepted) {
        const result = {
          status: "success" as const,
          accepted: true,
          message: "Terms already accepted. Proceed to main menu.",
        };
        console.log(`\n\nThis is the result is user already accepted TnC: ${result}`)
        return result
      }
      try {
        const lookup = await lookupCustomerByPhone(phone);
        if (lookup.found) {
          
          console.log(`\n\nThis is the result is user already accepted TnC in lookup: ${lookup}`)

          const onboarding = await getOnboardingStatus(phone);
          if (onboarding.terms_accepted || lookup.is_validated) {
            if (!onboarding.terms_accepted) await setServiceTermsAccepted(phone);
            return {
              status: "success" as const,
              accepted: true,
              message: "Terms already accepted. Proceed to main menu.",
            };
          }
        }
      } catch (err) {
        console.warn("[acceptTncTool] Local lookup failed; showing T&C prompt.", err);
      }
      return {
        status: "pending" as const,
        accepted: false,
        ui_template: TNC_TEMPLATE,
      };
    }

    // action === "accept"
    await setServiceTermsAccepted(phone);
    try {
      await updateOnboardingStatus(phone, "terms_accepted", true);
    } catch (err) {
      console.warn("[acceptTncTool] Onboarding flag update failed; T&C still saved locally.");
    }
    return {
      status: "success" as const,
      accepted: true,
      message:
        "Terms accepted and saved for this WhatsApp number.\n\n" +
        "Next step — call addNewAccountTool to link your bank account to WhatsApp, " +
        "then setTransactionPinTool to set your 4-digit transaction PIN.\n\n"
    };
  },
});


// ─── 2. Add New Account ──────────────────────────────────────────────────────

export const addNewAccountTool = createTool({
  id: "add-new-account",
  description:
    "Generates the WhatsApp UI prompt to link a bank account. Returns a <flow_action> tag that " +
    "send-agent-reply.ts resolves to a real Meta Flow message. " +
    "The flow ID is resolved from the LINK_ACCOUNT_FLOW_ID env variable.",
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
        "Great! Let's link your bank account to WhatsApp so you can start transacting.\n\n" +
        "Tap the button below to securely link your account.\n" +
        '<flow_action flow_id="LINK_ACCOUNT_FLOW" button_text="Link Bank Account" />',
    };
  },
});
