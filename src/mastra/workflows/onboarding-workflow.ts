import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { sendWhatsAppText } from "../../whatsapp-client.js";

/**
 * Onboarding Workflow
 * Orchestrates the multi-step customer registration and KYC verification process.
 * Steps: welcome → collect info → verify identity → activate → confirm
 */

const welcomeStep = createStep({
  id: "welcome",
  description: "Send welcome message and explain the onboarding process",
  inputSchema: z.object({
    phone: z.string(),
    isNewCustomer: z.boolean().default(true),
  }),
  outputSchema: z.object({
    phone: z.string(),
    isNewCustomer: z.boolean(),
    welcomeSent: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    const { phone, isNewCustomer } = inputData;
    const bankName = process.env.BANK_NAME || "First Bank Nigeria";
    const botName = process.env.BOT_NAME || "FBN Banking Assistant";

    const message = isNewCustomer
      ? `👋 Welcome to *${bankName}* digital onboarding!\n\n` +
        `I'm ${botName} and I'll guide you through setting up your WhatsApp banking account.\n\n` +
        `This will take about 5 minutes. Here's what we'll need:\n` +
        `1. Your full name and date of birth\n` +
        `2. Your BVN or NIN for identity verification\n\n` +
        `Your data is protected under NDPR regulations. Ready to start? Reply *YES* to continue.`
      : `👋 Welcome back to *${bankName}*!\n\n` +
        `Let's activate WhatsApp banking for your existing account.\n` +
        `Please provide your account number or registered phone number to proceed.`;

    await sendWhatsAppText(phone, message);
    return { phone, isNewCustomer, welcomeSent: true };
  },
});

const identityVerificationStep = createStep({
  id: "identity-verification",
  description: "Run BVN or NIN verification via NIBSS API",
  inputSchema: z.object({
    phone: z.string(),
    verificationMethod: z.enum(["bvn", "nin"]),
    verificationNumber: z.string(),
    dateOfBirth: z.string().optional(),
  }),
  outputSchema: z.object({
    phone: z.string(),
    verified: z.boolean(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    const { phone, verificationMethod, verificationNumber, dateOfBirth } = inputData;
    // Delegate to the core banking verification service
    // In a real flow this would call the NIBSS API directly
    console.log(`[OnboardingWorkflow] Verifying ${verificationMethod} for ${phone}`);
    // Mock: always verified in dev
    return {
      phone,
      verified: true,
      firstName: "John",
      lastName: "Doe",
    };
  },
});

const activationStep = createStep({
  id: "activation",
  description: "Save customer profile and send activation confirmation",
  inputSchema: z.object({
    phone: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string().optional(),
    kycMethod: z.enum(["bvn", "nin", "document"]),
  }),
  outputSchema: z.object({
    phone: z.string(),
    activated: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { phone, firstName, lastName, kycMethod } = inputData;
    const bankName = process.env.BANK_NAME || "First Bank Nigeria";
    const confirmMsg =
      `🎉 *Congratulations, ${firstName}!*\n\n` +
      `Your ${bankName} WhatsApp Banking account is now active.\n\n` +
      `You can now:\n` +
      `• Check your balance\n` +
      `• Transfer funds\n` +
      `• Pay bills\n` +
      `• Get spending insights\n\n` +
      `Type *MENU* anytime to see all available services. Banking at your fingertips! 🏦`;

    await sendWhatsAppText(phone, confirmMsg);
    return { phone, activated: true, message: confirmMsg };
  },
});

export const onboardingWorkflow = createWorkflow({
  id: "onboarding-workflow",
  description: "End-to-end customer onboarding and KYC verification workflow",
  inputSchema: z.object({
    phone: z.string(),
    isNewCustomer: z.boolean().default(true),
  }),
  outputSchema: z.object({
    completed: z.boolean(),
    phone: z.string(),
  }),
})
  .then(welcomeStep)
  .commit();
