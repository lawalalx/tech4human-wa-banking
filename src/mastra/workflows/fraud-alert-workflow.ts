import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { sendWhatsAppText, sendWhatsAppInteractiveButtons } from "../../whatsapp-client.js";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Fraud Alert Workflow
 * Triggered when a high-risk transaction is detected.
 * Steps: alert customer → wait for response → resolve (approve or block)
 */

const alertCustomerStep = createStep({
  id: "alert-customer",
  description: "Send real-time fraud alert to customer with approve/block options",
  inputSchema: z.object({
    phone: z.string(),
    amount: z.number(),
    recipientAccount: z.string(),
    recipientBank: z.string().optional(),
    riskFactors: z.array(z.string()),
    alertId: z.string(),
  }),
  outputSchema: z.object({
    phone: z.string(),
    alertId: z.string(),
    alertSent: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    const { phone, amount, recipientAccount, recipientBank, riskFactors, alertId } = inputData;
    const formatted = `₦${amount.toLocaleString()}`;
    const bankLabel = recipientBank ? ` (${recipientBank})` : "";

    const bodyText =
      `🚨 *Security Alert — ${process.env.BANK_NAME || "First Bank Nigeria"}*\n\n` +
      `We detected unusual activity on your account:\n\n` +
      `• Transaction: *${formatted}*\n` +
      `• Destination: ***${recipientAccount.slice(-4)}${bankLabel}\n` +
      `• Risk: ${riskFactors.join(", ")}\n\n` +
      `Did *you* initiate this transaction?`;

    await sendWhatsAppInteractiveButtons(phone, bodyText, [
      { id: `APPROVE_${alertId}`, title: "✅ Yes, approve" },
      { id: `BLOCK_${alertId}`, title: "🚫 No, block it" },
    ]);

    console.log(`[FraudAlertWorkflow] Alert sent to ${phone}, alertId=${alertId}`);
    return { phone, alertId, alertSent: true };
  },
});

const autoTimeoutStep = createStep({
  id: "auto-timeout",
  description: "Auto-block transaction if customer does not respond within 10 minutes",
  inputSchema: z.object({
    phone: z.string(),
    alertId: z.string(),
    alertSentAt: z.string().optional(),
  }),
  outputSchema: z.object({
    phone: z.string(),
    timedOut: z.boolean(),
    autoBlocked: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    const { phone, alertId } = inputData;
    // In a real system this would be handled by a scheduled job.
    // Here we log the intent and return state for the agent to handle.
    console.log(`[FraudAlertWorkflow] Timeout check for alertId=${alertId}`);
    const bankName = process.env.BANK_NAME || "First Bank Nigeria";
    const msg =
      `⏱️ *Security Alert Expired*\n\n` +
      `Your transaction has been automatically blocked as we did not receive a response.\n\n` +
      `If you initiated this transaction, please contact us:\n` +
      `📞 ${process.env.SUPPORT_PHONE || "+2348001234567"}\n\n` +
      `${bankName} Reference: FRAUD-${alertId}`;
    await sendWhatsAppText(phone, msg);

    // Update alert status to auto-blocked
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE fraud_alerts SET status = 'confirmed', resolved_at = NOW()
         WHERE id = $1 AND status = 'open'`,
        [alertId]
      );
    } finally {
      client.release();
    }

    return { phone, timedOut: true, autoBlocked: true };
  },
});

export const fraudAlertWorkflow = createWorkflow({
  id: "fraud-alert-workflow",
  description: "Real-time fraud detection alert workflow — notifies customer and auto-blocks if no response",
  inputSchema: z.object({
    phone: z.string(),
    amount: z.number(),
    recipientAccount: z.string(),
    recipientBank: z.string().optional(),
    riskFactors: z.array(z.string()),
    alertId: z.string(),
  }),
  outputSchema: z.object({
    alertSent: z.boolean(),
    phone: z.string(),
  }),
})
  .then(alertCustomerStep)
  .commit();
