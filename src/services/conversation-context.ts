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

import { AgentState } from "../core/agent-state.js";
import { getAuthorizationStatus, AuthorizationConfig } from "./authorization-service.js";

/**
 * Build system prompt for agent with full context
 */
export function buildSystemPrompt(
  state: AgentState,
  bankName: string = "FirstBank",
  botName: string = "Banking Assistant"
): string {
  const customer = state.session?.customerContext;
  const currentGoal = state.session?.currentGoal;
  const auth = getAuthorizationStatus(state);

  let systemPrompt = `You are ${botName}, a professional and conversational banking assistant for ${bankName} Nigeria.

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
 * Generate conversational prompt for PIN verification
 */
export function buildPinPrompt(
  state: AgentState,
  attempts: number = 0,
  maxAttempts: number = 3
): string {
  const remaining = maxAttempts - attempts;

  if (attempts === 0) {
    return `🔐 *VERIFY YOUR PIN*\n\nEnter your 4-digit transaction PIN to authorize this transaction.\n\n⏱️ Valid for 2 minutes.`;
  }

  if (remaining > 0) {
    return `❌ *INCORRECT PIN*\n\nYou have ${remaining} attempt(s) remaining.\n\nPlease try again with your 4-digit PIN.`;
  }

  return `🔒 *PIN LOCKED*\n\nYou've exceeded the maximum PIN attempts.\n\nYour PIN has been temporarily locked for security. Please try again in 5 minutes.`;
}

/**
 * Generate conversational prompt for OTP verification
 */
export function buildOtpPrompt(
  state: AgentState,
  phone: string,
  attempts: number = 0,
  maxAttempts: number = 3
): string {
  const remaining = maxAttempts - attempts;
  const maskedPhone = phone.replace(/(\d{3})\d{4}(\d{3})/, "$1****$2");

  if (attempts === 0) {
    return `📱 *OTP SENT*\n\nWe've sent a 4-digit code to ${maskedPhone}\n\n🔐 Enter the OTP below:\n(Valid for 5 minutes)`;
  }

  if (remaining > 0) {
    return `❌ *INCORRECT OTP*\n\nYou have ${remaining} attempt(s) remaining.\n\nPlease check your phone and try again.`;
  }

  return `🔒 *OTP VERIFICATION LOCKED*\n\nToo many failed attempts.\n\nPlease request a new OTP or contact support.`;
}

/**
 * Generate confirmation message for transaction
 */
export function buildTransactionConfirmation(
  state: AgentState,
  txnType: string
): string {
  const txnContext = state.session?.transactionContext;
  const customer = state.session?.customerContext;

  let message = `✅ *CONFIRM YOUR ${txnType.toUpperCase()}*\n\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  if (txnType === "transfer" && txnContext) {
    message += `📤 *Transfer Details*\n\n`;
    if (txnContext.recipientName) {
      message += `👤 To: ${txnContext.recipientName}\n`;
    }
    if (txnContext.recipientBank) {
      message += `🏦 Bank: ${txnContext.recipientBank}\n`;
    }
    if (txnContext.recipientAccount) {
      const masked = txnContext.recipientAccount.replace(/(.{3})(.*)(.{4})/, "$1****$3");
      message += `🔢 Account: ${masked}\n`;
    }
    if (txnContext.amount) {
      message += `💰 Amount: ₦${txnContext.amount.toLocaleString()}\n`;
    }
    if (txnContext.narration) {
      message += `📝 Description: ${txnContext.narration}\n`;
    }
  }

  message += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  message += `Reply *YES* to proceed or *NO* to cancel`;

  return message;
}

/**
 * Generate receipt message for completed transaction
 */
export function buildTransactionReceipt(
  state: AgentState,
  txnType: string,
  result: any
): string {
  const txnContext = state.session?.transactionContext;

  let message = `✅ *${txnType.toUpperCase()} SUCCESSFUL*\n\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  if (result.transactionRef) {
    message += `📋 Reference: ${result.transactionRef}\n`;
  }

  if (txnType === "transfer" && txnContext) {
    message += `\n👤 Recipient: ${txnContext.recipientName || "N/A"}\n`;
    message += `🏦 Bank: ${txnContext.recipientBank || "N/A"}\n`;
    if (txnContext.amount) {
      message += `💰 Amount: ₦${txnContext.amount.toLocaleString()}\n`;
    }
  }

  if (result.timestamp) {
    const date = new Date(result.timestamp);
    message += `\n⏰ Time: ${date.toLocaleString("en-NG")}\n`;
  }

  message += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  message += `\n📧 A receipt has been sent to your email.\n`;
  message += `\nHow can I help you next?`;

  return message;
}

/**
 * Generate error message with context
 */
export function buildErrorMessage(
  errorType: string,
  context: Record<string, any> = {}
): string {
  const messages: Record<string, (ctx: any) => string> = {
    invalid_account: (ctx) =>
      `❌ *ACCOUNT NOT FOUND*\n\nThe account number "${ctx.account}" could not be verified.\n\nPlease check and try again.`,

    insufficient_funds: (ctx) =>
      `❌ *INSUFFICIENT FUNDS*\n\nYour available balance is ₦${(ctx.balance || 0).toLocaleString()}.\n\nYou cannot transfer ₦${(ctx.amount || 0).toLocaleString()}.`,

    transfer_limit_exceeded: (ctx) =>
      `❌ *TRANSFER LIMIT EXCEEDED*\n\nYour daily transfer limit is ₦${(ctx.limit || 0).toLocaleString()}.\n\nPlease try again tomorrow or contact support.`,

    kyc_required: (ctx) =>
      `🆔 *KYC VERIFICATION REQUIRED*\n\nTo perform this transaction, you need to complete KYC verification.\n\nWould you like to proceed with KYC?`,

    service_unavailable: (ctx) =>
      `⚠️ *SERVICE TEMPORARILY UNAVAILABLE*\n\nWe're experiencing technical difficulties.\n\nPlease try again in a few moments.`,

    unknown_error: (ctx) =>
      `❌ *ERROR*\n\nSomething went wrong. Please try again or contact support if the problem persists.`,
  };

  const builder = messages[errorType] || messages.unknown_error;
  return builder(context);
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

/**
 * Generate menu message
 */
export function buildMenuMessage(bankName: string = "FirstBank"): string {
  return `👋 Welcome to *${bankName}* WhatsApp Banking!\n\n` +
    `Here's what I can help you with:\n\n` +
    `💰 *Account & Transactions*\n` +
    `   - Check balance\n` +
    `   - View statement\n` +
    `   - Send money\n` +
    `   - Pay bills\n\n` +
    `🆔 *Onboarding & KYC*\n` +
    `   - Open account\n` +
    `   - Verify identity\n` +
    `   - Activate channel\n\n` +
    `🔒 *Security*\n` +
    `   - Fraud alerts\n` +
    `   - Block card\n` +
    `   - Manage devices\n\n` +
    `📊 *Financial Insights*\n` +
    `   - Spending analysis\n` +
    `   - Budget planning\n` +
    `   - Credit score\n\n` +
    `💬 *Support*\n` +
    `   - FAQs\n` +
    `   - Complaints\n` +
    `   - Speak to agent\n\n` +
    `Just type what you need!`;
}
