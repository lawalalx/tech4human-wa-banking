import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Pool } from "pg";
import { randomUUID } from "crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Audit logging tool — append-only event log for compliance.
 * Logs all AI interactions for CBN, NDPR, and PCI-DSS requirements.
 * Retention: 7 years minimum.
 */
export const auditLogTool = createTool({
  id: "log-audit-event",
  description:
    "Log an auditable event for compliance purposes. " +
    "Call for every significant action: transactions, auth events, escalations, fraud alerts. " +
    "Logs are immutable and retained for 7 years per CBN requirements.",
  inputSchema: z.object({
    phone: z.string().optional().describe("Customer phone (if known)"),
    sessionId: z.string().optional(),
    eventType: z
      .string()
      .describe(
        "Event type e.g. transaction_initiated, otp_sent, escalation_created, fraud_alert_triggered"
      ),
    agentId: z.string().optional().describe("The agent that triggered this event"),
    inputSummary: z.string().optional().describe("Sanitised summary of input (no PII)"),
    outputSummary: z.string().optional().describe("Sanitised summary of output"),
    metadata: z.record(z.unknown()).optional(),
  }),
  outputSchema: z.object({
    logged: z.boolean(),
    eventId: z.string().optional(),
  }),
  execute: async ({
    phone,
    sessionId,
    eventType,
    agentId,
    inputSummary,
    outputSummary,
    metadata,
  }: {
    phone?: string;
    sessionId?: string;
    eventType: string;
    agentId?: string;
    inputSummary?: string;
    outputSummary?: string;
    metadata?: Record<string, unknown>;
  }) => {
    const eventId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO audit_log (event_id, phone, session_id, event_type, agent_id, input_summary, output_summary, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          eventId,
          phone ?? null,
          sessionId ?? null,
          eventType,
          agentId ?? null,
          inputSummary ?? null,
          outputSummary ?? null,
          JSON.stringify(metadata ?? {}),
        ]
      );
      return { logged: true, eventId };
    } catch (err) {
      console.error("[Audit] Failed to log event:", err);
      return { logged: false };
    } finally {
      client.release();
    }
  },
});

/**
 * Notification preferences tool — manage customer notification settings.
 */
export const updateNotificationPrefsTool = createTool({
  id: "update-notification-prefs",
  description:
    "Update a customer's transaction notification preferences. " +
    "Customers can choose: all transactions, debits only, or above a threshold amount.",
  inputSchema: z.object({
    phone: z.string(),
    allTransactions: z.boolean().optional(),
    debitsOnly: z.boolean().optional(),
    thresholdAmount: z.number().optional().describe("Only notify for transactions above this amount"),
    marketingOptIn: z.boolean().optional(),
  }),
  outputSchema: z.object({
    updated: z.boolean(),
    message: z.string(),
  }),
  execute: async ({
    phone,
    allTransactions,
    debitsOnly,
    thresholdAmount,
    marketingOptIn,
  }: {
    phone: string;
    allTransactions?: boolean;
    debitsOnly?: boolean;
    thresholdAmount?: number;
    marketingOptIn?: boolean;
  }) => {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO notification_preferences (phone, all_transactions, debits_only, threshold_amount, marketing_opt_in)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (phone) DO UPDATE SET
           all_transactions = COALESCE($2, notification_preferences.all_transactions),
           debits_only = COALESCE($3, notification_preferences.debits_only),
           threshold_amount = COALESCE($4, notification_preferences.threshold_amount),
           marketing_opt_in = COALESCE($5, notification_preferences.marketing_opt_in),
           updated_at = NOW()`,
        [
          phone,
          allTransactions ?? null,
          debitsOnly ?? null,
          thresholdAmount ?? null,
          marketingOptIn ?? null,
        ]
      );
      return { updated: true, message: "✅ Notification preferences updated." };
    } finally {
      client.release();
    }
  },
});
