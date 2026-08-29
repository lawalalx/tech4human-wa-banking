/**
 * Conversation Context Builder
 * 
 * Generates conversational, context-aware messages without hardcoding.
 * Dynamically builds prompts based on:
 * - Current transaction state
 * - Customer context
 * - Authorization status
 * - Conversation history
 */
import { 
  botName, 
  businessName,
} from "@/utils/identity.js";

import { AgentState } from "../core/agent-state.js";
import { getAuthorizationStatus, AuthorizationConfig } from "./authorization-service.js";

/**
 * Build system prompt for agent with full context
 */
export function buildSystemPrompt(
  state: AgentState,
): string {
  const customer = state.session?.customerContext;
  const currentGoal = state.session?.currentGoal;
  const auth = getAuthorizationStatus(state);

  let systemPrompt = `You are ${botName}, a professional and conversational banking assistant for ${businessName} Nigeria.

## Your Role
- Help customers with banking transactions (balance, transfers, bill payments, statements)
- Guide through KYC/onboarding processes
- Provide security guidance
- Maintain context across multi-turn conversations
- Be warm, professional, and concise

## Communication Style
- Use natural, conversational language
- Include relevant emojis for clarity (✅, ❌, 🔐, 📱, etc.)
- Provide clear next steps
- Ask clarifying questions when needed
- Never be robotic or overly formal

## Customer Context
`;

  if (customer?.firstName) {
    systemPrompt += `- Customer: ${customer.firstName}\n`;
  }
  if (customer?.accountNumber) {
    systemPrompt += `- Account: ${customer.accountNumber}\n`;
  }
  if (customer?.kycTier) {
    systemPrompt += `- KYC Tier: ${customer.kycTier}\n`;
  }

  systemPrompt += `\n## Current Transaction State\n`;
  if (currentGoal) {
    systemPrompt += `- Action: ${currentGoal.action}\n`;
    systemPrompt += `- Status: ${currentGoal.status}\n`;
    systemPrompt += `- Description: ${currentGoal.description}\n`;
  }

  systemPrompt += `\n## Authorization Status\n`;
  systemPrompt += `- PIN: ${auth.pinStatus}`;
  if (auth.pinStatus === "verified") {
    systemPrompt += ` (${auth.pinRemainingSeconds}s remaining)`;
  }
  systemPrompt += `\n`;
  systemPrompt += `- OTP: ${auth.otpStatus}`;
  if (auth.otpStatus === "verified") {
    systemPrompt += ` (${auth.otpRemainingSeconds}s remaining)`;
  }
  systemPrompt += `\n`;

  systemPrompt += `\n## Key Rules
1. Always maintain transaction context
2. Confirm recipient details before transfers
3. Enforce PIN/OTP verification for financial transactions
4. Never ask for sensitive data unnecessarily
5. Provide clear error messages with next steps
6. Support session resumption gracefully`;

  return systemPrompt;
}

/**
 * Build user context prompt for current message
 */
export function buildUserContextPrompt(state: AgentState): string {
  const history = state.session?.conversationHistory || [];
  const currentGoal = state.session?.currentGoal;
  const txnContext = state.session?.transactionContext;

  let context = "";

  // Recent conversation context
  if (history.length > 0) {
    const recent = history.slice(-4); // Last 4 messages
    context += "## Recent Conversation\n";
    for (const msg of recent) {
      const role = msg.role === "user" ? "Customer" : "You";
      context += `${role}: ${msg.content}\n`;
    }
    context += "\n";
  }

  // Current transaction context
  if (currentGoal && currentGoal.status !== "idle") {
    context += "## Active Transaction\n";
    context += `- Type: ${currentGoal.action}\n`;
    context += `- Status: ${currentGoal.status}\n`;

    if (txnContext) {
      if (txnContext.recipientName) {
        context += `- Recipient: ${txnContext.recipientName}\n`;
      }
      if (txnContext.recipientBank) {
        context += `- Bank: ${txnContext.recipientBank}\n`;
      }
      if (txnContext.amount) {
        context += `- Amount: ₦${txnContext.amount.toLocaleString()}\n`;
      }
    }
    context += "\n";
  }

  return context;
}

/**
 * Generate resumption message for returning customers
 */
export function buildResumptionMessage(
  state: AgentState,
  lastAction?: string,
  minutesAway?: number
): string {
  const customer = state.session?.customerContext;
  const firstName = customer?.firstName || "there";

  let message = `👋 *Welcome back, ${firstName}!*\n\n`;

  if (minutesAway && minutesAway > 5) {
    message += `It's been a while since we last spoke.\n\n`;
  }

  if (lastAction) {
    message += `I see you were working on: *${lastAction}*\n\n`;
    message += `Would you like to:\n`;
    message += `1️⃣ Continue where you left off\n`;
    message += `2️⃣ Start something new\n\n`;
    message += `Just let me know!`;
  } else {
    message += `How can I help you today?`;
  }

  return message;
}
