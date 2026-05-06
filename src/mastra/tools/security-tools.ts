import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Pool } from "pg";
import { randomUUID } from "crypto";
import { sendWhatsAppInteractiveButtons, sendWhatsAppText } from "../../whatsapp-client.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── Fraud Risk Assessment ─────────────────────────────────────────────────────

export const fraudCheckTool = createTool({
  id: "check-fraud-risk",
  description:
    "Assess the fraud risk for a pending transaction before processing. " +
    "Returns a risk score 0–1 and risk factors. " +
    "If score > 0.6, hold the transaction and alert the customer.",
  inputSchema: z.object({
    phone: z.string(),
    amount: z.number(),
    recipientAccount: z.string(),
    recipientBank: z.string().optional(),
    isNewRecipient: z.boolean().optional().default(false),
    isNewDevice: z.boolean().optional().default(false),
    transactionType: z.enum(["intra_transfer", "interbank_transfer", "bill_payment"]),
  }),
  outputSchema: z.object({
    riskScore: z.number().describe("Composite risk score 0–1"),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    riskFactors: z.array(z.string()),
    action: z.enum(["allow", "require_otp", "hold_and_alert", "block"]),
    alertId: z.string().optional(),
  }),
  execute: async ({
    phone,
    amount,
    recipientAccount,
    recipientBank,
    isNewRecipient = false,
    isNewDevice = false,
    transactionType,
  }: {
    phone: string;
    amount: number;
    recipientAccount: string;
    recipientBank?: string;
    isNewRecipient?: boolean;
    isNewDevice?: boolean;
    transactionType: string;
  }) => {
    let score = 0;
    const factors: string[] = [];

    // New device usage
    if (isNewDevice) {
      score += 0.4;
      factors.push("Transaction from unregistered device");
    }

    // New beneficiary
    if (isNewRecipient) {
      score += 0.2;
      factors.push("First-time transfer to this recipient");
    }

    // Large amount heuristic (above 500k NGN)
    if (amount > 500000) {
      score += 0.3;
      factors.push("Large transaction amount");
    }

    // Off-hours check (10 PM – 5 AM WAT = UTC 21:00 – 04:00)
    const hour = new Date().getUTCHours();
    if (hour >= 21 || hour <= 4) {
      score += 0.1;
      factors.push("Off-hours transaction");
    }

    const clampedScore = Math.min(score, 1);
    let riskLevel: "low" | "medium" | "high" | "critical";
    let action: "allow" | "require_otp" | "hold_and_alert" | "block";

    if (clampedScore < 0.3) {
      riskLevel = "low";
      action = "allow";
    } else if (clampedScore < 0.6) {
      riskLevel = "medium";
      action = "require_otp";
    } else if (clampedScore < 0.8) {
      riskLevel = "high";
      action = "hold_and_alert";
    } else {
      riskLevel = "critical";
      action = "block";
    }

    // Log alert if high/critical
    let alertId: string | undefined;
    if (action === "hold_and_alert" || action === "block") {
      const client = await pool.connect();
      try {
        const txnRef = `FRAUD-${Date.now()}`;
        const result = await client.query(
          `INSERT INTO fraud_alerts (phone, transaction_ref, risk_score, risk_factors, status)
           VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
          [phone, txnRef, clampedScore, JSON.stringify(factors)]
        );
        alertId = String(result.rows[0].id);
      } finally {
        client.release();
      }

      // Send alert to customer
      const amountFormatted = `₦${amount.toLocaleString()}`;
      const bodyText =
        `🚨 *Security Alert*\n\nWe detected unusual activity on your account.\n\n` +
        `Transaction: ${amountFormatted} to ${recipientAccount}${recipientBank ? ` (${recipientBank})` : ""}\n\n` +
        `Risk factors: ${factors.join(", ")}\n\n` +
        `Did you initiate this transaction?`;

      await sendWhatsAppInteractiveButtons(phone, bodyText, [
        { id: `APPROVE_${alertId}`, title: "✅ Yes, approve" },
        { id: `BLOCK_${alertId}`, title: "🚫 No, block it" },
      ]);
    }

    console.log(`[FraudCheck] ${phone} score=${clampedScore} action=${action}`);
    return { riskScore: clampedScore, riskLevel, riskFactors: factors, action, alertId };
  },
});

// ─── Resolve Fraud Alert ──────────────────────────────────────────────────────

export const resolveFraudAlertTool = createTool({
  id: "resolve-fraud-alert",
  description:
    "Resolve a pending fraud alert. Called when the customer approves or blocks a held transaction.",
  inputSchema: z.object({
    alertId: z.string(),
    resolution: z.enum(["confirmed_fraud", "false_positive"]),
    phone: z.string(),
  }),
  outputSchema: z.object({
    updated: z.boolean(),
  }),
  execute: async ({
    alertId,
    resolution,
    phone,
  }: {
    alertId: string;
    resolution: "confirmed_fraud" | "false_positive";
    phone: string;
  }) => {
    const status = resolution === "false_positive" ? "cleared" : "confirmed";
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE fraud_alerts SET status = $1, resolved_at = NOW() WHERE id = $2 AND phone = $3`,
        [status, alertId, phone]
      );
      if (resolution === "confirmed_fraud") {
        await sendWhatsAppText(
          phone,
          `🔒 Transaction blocked successfully. Your account is secure.\n` +
            `Our security team has been notified. Reference: FRAUD-${alertId}\n` +
            `Call ${process.env.SUPPORT_PHONE || "our support line"} if you need immediate help.`
        );
      }
      return { updated: true };
    } finally {
      client.release();
    }
  },
});

// ─── Device Session Management ────────────────────────────────────────────────

export const listSessionsTool = createTool({
  id: "list-sessions",
  description:
    "List all registered devices and active sessions for a customer. " +
    "Used for device binding and session management (US-013).",
  inputSchema: z.object({
    phone: z.string(),
  }),
  outputSchema: z.object({
    devices: z.array(
      z.object({
        deviceId: z.string(),
        deviceName: z.string().optional(),
        trusted: z.boolean(),
        lastSeen: z.string(),
        registeredAt: z.string(),
      })
    ),
  }),
  execute: async ({ phone }: { phone: string }) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT device_id, device_name, trusted, last_seen, registered_at
         FROM device_registry
         WHERE phone = $1 AND revoked_at IS NULL
         ORDER BY last_seen DESC`,
        [phone]
      );
      return {
        devices: result.rows.map((r) => ({
          deviceId: r.device_id,
          deviceName: r.device_name,
          trusted: r.trusted,
          lastSeen: r.last_seen,
          registeredAt: r.registered_at,
        })),
      };
    } finally {
      client.release();
    }
  },
});

export const revokeSessionTool = createTool({
  id: "revoke-session",
  description: "Revoke a device / session for the customer. Used when they detect unauthorised access.",
  inputSchema: z.object({
    phone: z.string(),
    deviceId: z.string().describe("The device ID to revoke"),
  }),
  outputSchema: z.object({
    revoked: z.boolean(),
  }),
  execute: async ({ phone, deviceId }: { phone: string; deviceId: string }) => {
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE device_registry SET revoked_at = NOW() WHERE phone = $1 AND device_id = $2`,
        [phone, deviceId]
      );
      return { revoked: true };
    } finally {
      client.release();
    }
  },
});
