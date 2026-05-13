import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { transactionWorkflow } from "../workflows/transaction-workflow.js";

export const runTransactionWorkflowTool = createTool({
  id: "run-transaction-workflow",
  description:
    "Run the deterministic transaction workflow for balance, mini statement, transfer, and bill payment. " +
    "Always call this FIRST for any transaction intent. " +
    "Pass customer's phone from context, the customer's latest message verbatim, and the transaction action if known. " +
    "If handled=true, return reply exactly and do not run other transaction tools in this turn.",
  inputSchema: z.object({
    phone: z.string().describe("Customer phone from context"),
    message: z.string().describe("Customer latest message exactly as sent"),
    action: z.enum(["balance", "mini_statement", "transfer", "bill_payment"]).optional(),
  }),
  outputSchema: z.object({
    handled: z.boolean(),
    reply: z.string(),
  }),
  execute: async ({ phone, message, action }: { phone: string; message: string; action?: "balance" | "mini_statement" | "transfer" | "bill_payment" }) => {
    try {
      const run = await transactionWorkflow.createRun();
      const result = await run.start({
        inputData: {
          phone,
          message,
          action,
        },
      });

      if (result.status !== "success") {
        return {
          handled: true,
          reply: "I ran into a temporary issue processing this transaction flow. Please try again.",
        };
      }

      return result.result;
    } catch {
      return {
        handled: true,
        reply: "I ran into a temporary issue processing this transaction flow. Please try again.",
      };
    }
  },
});