import "dotenv/config";
import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { sharedPgStore } from "./core/db/shared-pg-store.js";
import { bankingWorkspace } from "./workspace.js";

// Agents
import { bankingSupervisor } from "./agents/banking-supervisor.js";
import { onboardingAgent } from "./agents/onboarding-agent.js";
import { transactionAgent } from "./agents/transaction-agent.js";
import { securityAgent } from "./agents/security-agent.js";
import { supportAgent } from "./agents/support-agent.js";
import { insightsAgent } from "./agents/insights-agent.js";

// Workflows
import { onboardingWorkflow } from "./workflows/onboarding-workflow.js";
import { transactionWorkflow } from "./workflows/transaction-workflow.js";
import { fraudAlertWorkflow } from "./workflows/fraud-alert-workflow.js";
import { pinCheckWorkflow } from "./workflows/pin-workflow.js";

export const mastra = new Mastra({
  agents: {
    bankingSupervisor,
    onboardingAgent,
    transactionAgent, // Call as function to ensure fresh instance with correct context
    securityAgent,
    supportAgent,
    insightsAgent,
  },
  workflows: {
    onboardingWorkflow,
    transactionWorkflow,
    fraudAlertWorkflow,
    pinCheckWorkflow,
  },
  storage: sharedPgStore,
  workspace: bankingWorkspace,
  logger: new PinoLogger({ name: "tech4human-wa-banking", level: "info" }),
});
