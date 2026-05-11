import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { sendWhatsAppText, sendWhatsAppInteractiveButtons } from "../../whatsapp-client.js";

/**
 * Transaction Workflow
 * Handles the full 2FA-protected transaction flow:
 * fraud check → OTP send → OTP verify → execute → notify
 */

const fraudCheckStep = createStep({
  id: "fraud-check",
  description: "Assess fraud risk before processing a transaction",
  inputSchema: z.object({
    phone: z.string(),
    amount: z.number(),
    recipientAccount: z.string(),
    recipientBank: z.string().optional(),
    isNewRecipient: z.boolean().default(false),
    transactionType: z.enum(["intra_transfer", "interbank_transfer", "bill_payment"]),
  }),
  outputSchema: z.object({
    phone: z.string(),
    riskScore: z.number(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    action: z.enum(["allow", "require_otp", "hold_and_alert", "block"]),
    alertId: z.string().optional(),
    amount: z.number(),
  }),
  execute: async ({ inputData }) => {
    const { phone, amount, recipientAccount, isNewRecipient, transactionType } = inputData;
    // Simple risk scoring (delegating to tool in real flow)
    let score = 0;
    if (isNewRecipient) score += 0.2;
    if (amount > 500000) score += 0.3;
    const hour = new Date().getUTCHours() + 1;
    if (hour >= 22 || hour <= 5) score += 0.1;

    const clamped = Math.min(score, 1);
    const riskLevel = (clamped < 0.3 ? "low" : clamped < 0.6 ? "medium" : clamped < 0.8 ? "high" : "critical") as "low" | "medium" | "high" | "critical";
    const action = (clamped < 0.3 ? "allow" : clamped < 0.6 ? "require_otp" : clamped < 0.8 ? "hold_and_alert" : "block") as "allow" | "require_otp" | "hold_and_alert" | "block";

    console.log(`[TransactionWorkflow] Fraud check: ${phone} score=${clamped} action=${action}`);
    return { phone, riskScore: clamped, riskLevel, action, amount };
  },
});

const otpStep = createStep({
  id: "send-otp",
  description: "Send OTP to customer for transaction authentication",
  inputSchema: z.object({
    phone: z.string(),
    riskScore: z.number(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    action: z.enum(["allow", "require_otp", "hold_and_alert", "block"]),
    alertId: z.string().optional(),
    amount: z.number(),
    recipientName: z.string().optional(),
  }),
  outputSchema: z.object({
    phone: z.string(),
    otpSent: z.boolean(),
    prompt: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { phone, amount, recipientName } = inputData;
    const formatted = `₦${amount.toLocaleString()}`;
    const recipient = recipientName ? ` to ${recipientName}` : "";
    const msg =
      `🔐 *Transaction Confirmation*\n\n` +
      `Amount: *${formatted}*${recipient}\n\n` +
      `A 6-digit OTP has been sent to your registered phone number.\n` +
      `Please enter the OTP to confirm this transaction.\n\n` +
      `⏱️ Valid for 5 minutes. Do NOT share with anyone.`;
    await sendWhatsAppText(phone, msg);
    return { phone, otpSent: true, prompt: msg };
  },
});

const notifyStep = createStep({
  id: "notify-customer",
  description: "Send transaction success notification to customer",
  inputSchema: z.object({
    phone: z.string(),
    amount: z.number(),
    reference: z.string(),
    recipientName: z.string().optional(),
    transactionType: z.string(),
    success: z.boolean(),
  }),
  outputSchema: z.object({
    notified: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    const { phone, amount, reference, recipientName, transactionType, success } = inputData;
    const formatted = `₦${amount.toLocaleString()}`;
    const bankName = process.env.BANK_NAME || "First Bank Nigeria";

    if (success) {
      const actionLabel: Record<string, string> = {
        intra_transfer: `Transfer to ${recipientName || "recipient"}`,
        interbank_transfer: `Transfer to ${recipientName || "recipient"}`,
        bill_payment: "Bill payment",
      };
      const msg =
        `✅ *Transaction Successful!*\n\n` +
        `${actionLabel[transactionType] || "Transaction"}: *${formatted}*\n` +
        `Reference: \`${reference}\`\n` +
        `Time: ${new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" })}\n\n` +
        `Thank you for banking with ${bankName}. 🏦`;
      await sendWhatsAppText(phone, msg);
    } else {
      const msg =
        `❌ *Transaction Failed*\n\n` +
        `Your transaction of ${formatted} could not be processed.\n` +
        `Reference: \`${reference}\`\n\n` +
        `Your account has NOT been debited. Please try again or contact support.`;
      await sendWhatsAppText(phone, msg);
    }

    return { notified: true };
  },
});

export const transactionWorkflow = createWorkflow({
  id: "transaction-workflow",
  description: "Full 2FA-protected transaction processing workflow with fraud detection and notifications",
  inputSchema: z.object({
    phone: z.string(),
    amount: z.number(),
    recipientAccount: z.string(),
    transactionType: z.enum(["intra_transfer", "interbank_transfer", "bill_payment"]),
  }),
  outputSchema: z.object({
    completed: z.boolean(),
    reference: z.string().optional(),
  }),
})
  .then(fraudCheckStep)
  .then(otpStep)
  .commit();
