import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Pool } from "pg";
import { randomUUID } from "crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function generateTicketId(): string {
  return "T-" + randomUUID().slice(0, 8).toUpperCase();
}

// ─── Create Escalation Ticket ─────────────────────────────────────────────────

export const createEscalationTicketTool = createTool({
  id: "create-escalation-ticket",
  description:
    "Create a support escalation ticket and connect the customer to a human agent. " +
    "Use when customer asks for a human agent, or issue cannot be resolved automatically. " +
    "Returns a ticket reference the customer can use to track their issue.",
  inputSchema: z.object({
    phone: z.string(),
    category: z
      .enum([
        "transaction_dispute",
        "account_issue",
        "card_issue",
        "fraud",
        "general_enquiry",
        "complaint",
        "loan_enquiry",
        "other",
      ])
      .describe("Category of the issue"),
    description: z.string().describe("Brief description of the customer's issue"),
    priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    conversationSummary: z.string().optional().describe("Summary of the conversation so far"),
  }),
  outputSchema: z.object({
    created: z.boolean(),
    ticketId: z.string().optional(),
    estimatedResponseTime: z.string(),
    isBusinessHours: z.boolean(),
  }),
  execute: async ({
    phone,
    category,
    description,
    priority = "medium",
    conversationSummary,
  }: {
    phone: string;
    category: string;
    description: string;
    priority?: string;
    conversationSummary?: string;
  }) => {
    const ticketId = generateTicketId();
    const isBusinessHours = (() => {
      const now = new Date();
      const hour = now.getUTCHours() + 1; // WAT = UTC+1
      const day = now.getUTCDay(); // 0=Sun, 6=Sat
      return day >= 1 && day <= 5 && hour >= 8 && hour < 17;
    })();

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO escalation_tickets (ticket_id, phone, category, description, priority)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          ticketId,
          phone,
          category,
          `${description}${conversationSummary ? `\n\nConversation Summary:\n${conversationSummary}` : ""}`,
          priority,
        ]
      );
      return {
        created: true,
        ticketId,
        estimatedResponseTime: isBusinessHours
          ? "under 3 minutes"
          : "next business day by 9 AM",
        isBusinessHours,
      };
    } catch (err) {
      console.error("[Escalation] Failed to create ticket:", err);
      return { created: false, estimatedResponseTime: "unknown", isBusinessHours };
    } finally {
      client.release();
    }
  },
});

// ─── Query Ticket Status ──────────────────────────────────────────────────────

export const queryTicketStatusTool = createTool({
  id: "query-ticket-status",
  description:
    "Check the status of an existing support ticket by ticket reference number.",
  inputSchema: z.object({
    ticketId: z.string().describe("The ticket reference e.g. T-ABCD1234"),
    phone: z.string().describe("Requesting customer's phone for auth check"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    status: z.string().optional(),
    category: z.string().optional(),
    createdAt: z.string().optional(),
    resolvedAt: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ ticketId, phone }: { ticketId: string; phone: string }) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT status, category, created_at, resolved_at
         FROM escalation_tickets
         WHERE ticket_id = $1 AND phone = $2`,
        [ticketId.toUpperCase(), phone]
      );
      if (result.rows.length === 0) {
        return {
          found: false,
          message: `Ticket ${ticketId} not found for your account. Please check the reference.`,
        };
      }
      const t = result.rows[0];
      const statusMessages: Record<string, string> = {
        open: "Your ticket is open and awaiting assignment.",
        assigned: "Your ticket is assigned to an agent and being reviewed.",
        resolved: "Your ticket has been resolved.",
        closed: "Your ticket is closed.",
      };
      return {
        found: true,
        status: t.status,
        category: t.category,
        createdAt: t.created_at,
        resolvedAt: t.resolved_at,
        message: statusMessages[t.status] || `Status: ${t.status}`,
      };
    } finally {
      client.release();
    }
  },
});


// Delete a ticket if it was created in error or issue resolved by other means
export const deleteTicketTool = createTool({
  id: "delete-ticket",
  description:
    "Delete an existing support ticket. Use only if the ticket was created in error or issue resolved by other means.",
  inputSchema: z.object({
    ticketId: z.string().describe("The ticket reference e.g. T-ABCD1234"),
    phone: z.string().describe("Requesting customer's phone for auth check"),
  }),
  outputSchema: z.object({
    deleted: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ ticketId, phone }: { ticketId: string; phone: string }) => {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM escalation_tickets
         WHERE ticket_id = $1 AND phone = $2
         RETURNING id`,
        [ticketId.toUpperCase(), phone]
      );
      if (result.rowCount === 0) {
        return { deleted: false, message: `Ticket ${ticketId} not found or already deleted.` };
      }
      return { deleted: true, message: `Ticket ${ticketId} has been deleted.` };
    } finally {
      client.release();
    }
  },
});
