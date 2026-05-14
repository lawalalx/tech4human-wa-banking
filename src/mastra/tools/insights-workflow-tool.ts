import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { insightsWorkflow } from "../workflows/insights-workflow.js";

export const runInsightsWorkflowTool = createTool({
  id: "run-insights-workflow",
  description:
    "Run the deterministic insights workflow for spending analysis, charts, budget setup, and credit score. " +
    "Always call this first for insights requests. If handled=true, return reply exactly and stop.",
  inputSchema: z.object({
    phone: z.string().describe("Customer phone from context"),
    message: z.string().describe("Customer latest message exactly as sent"),
  }),
  outputSchema: z.object({
    handled: z.boolean(),
    reply: z.string(),
  }),
  execute: async ({ phone, message }: { phone: string; message: string }) => {
    try {
      const run = await insightsWorkflow.createRun();
      const result = await run.start({
        inputData: {
          phone,
          message,
        },
      });

      if (result.status !== "success") {
        return {
          handled: true,
          reply: "I ran into a temporary issue while processing your insights request. Please try again.",
        };
      }

      return result.result;
    } catch {
      return {
        handled: true,
        reply: "I ran into a temporary issue while processing your insights request. Please try again.",
      };
    }
  },
});
