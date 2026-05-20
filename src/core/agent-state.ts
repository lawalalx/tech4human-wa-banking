/**
 * Agent State Model - Comprehensive context engineering for FirstBank WhatsApp Agent
 * 
 * Based on context engineering principles:
 * - Current Goal: What the agent is working toward
 * - Conversation Context: Short-term memory
 * - Knowledge Base: Long-term facts
 * - Intermediate Results: Working memory for current task
 * - Tool State: Available and used tools
 * - Task Progress: Completion status of multi-step tasks
 * - State Lifecycle: Ephemeral, session, persistent
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// STATE LIFECYCLE LEVELS
// ─────────────────────────────────────────────────────────────────────────────

/** Ephemeral state: lives for a single message cycle */
export const EphemeralStateSchema = z.object({
  /** Current message being processed */
  currentMessage: z.string(),
  /** LLM intent classification for this message */
  detectedIntent: z.enum(["balance", "mini_statement", "transfer", "bill_payment", "unknown", "greeting", "support"]),
  /** Parsed parameters from current message */
  extractedParams: z.record(z.string(), z.any()).optional(),
  /** Confidence score for intent detection (0-1) */
  intentConfidence: z.number().min(0).max(1).optional(),
  /** Timestamp when this message was received */
  messageTimestamp: z.string().datetime(),
});

/** Session state: persists across multiple messages in one conversation */
export const SessionStateSchema = z.object({
  phone: z.string(),
  conversationHistory: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    timestamp: z.string().datetime(),
    intent: z.string().optional(),
  })),
  /** Current active goal and its status */
  currentGoal: z.object({
    action: z.enum(["balance", "mini_statement", "transfer", "bill_payment", "kyc", "unknown"]),
    description: z.string(),
    status: z.enum(["idle", "in_progress", "pending_confirmation", "pending_pin", "pending_otp", "completed", "failed"]),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  }).optional(),
  /** Task plan for multi-step goals */
  taskPlan: z.array(z.object({
    step: z.number(),
    description: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "skipped"]),
    completedAt: z.string().datetime().optional(),
  })).optional(),
  /** Current step in task plan (0-indexed) */
  currentStep: z.number().default(0),
  /** Intermediate results from tools/steps */
  workingMemory: z.record(z.string(), z.any()).optional(),
  /** Which tools have been used in this session */
  toolsUsed: z.array(z.string()).default([]),
  /** Available tools for current goal */
  availableTools: z.array(z.string()).optional(),
  
  // ─────────────────────────────────────────────────────────────────────────
  // AUTHORIZATION & SECURITY STATE (NEW)
  // ─────────────────────────────────────────────────────────────────────────
  
  /** PIN verification state */
  authorizationState: z.object({
    pinVerified: z.boolean().default(false),
    pinVerifiedAt: z.string().datetime().optional(),
    pinAttempts: z.number().default(0),
    pinTimeout: z.number().optional(), // milliseconds until PIN expires
    
    otpCode: z.string().optional(),
    otpSentAt: z.string().datetime().optional(),
    otpVerified: z.boolean().default(false),
    otpVerifiedAt: z.string().datetime().optional(),
    otpAttempts: z.number().default(0),
    otpTimeout: z.number().optional(), // milliseconds until OTP expires
  }).optional(),
  
  // ─────────────────────────────────────────────────────────────────────────
  // CONTEXT & PERSONALIZATION (NEW)
  // ─────────────────────────────────────────────────────────────────────────
  
  /** Transaction context for current flow */
  transactionContext: z.object({
    recipientName: z.string().optional(),
    recipientBank: z.string().optional(),
    recipientAccount: z.string().optional(),
    amount: z.number().optional(),
    narration: z.string().optional(),
    transactionRef: z.string().optional(),
  }).optional(),
  
  /** Customer context for personalization */
  customerContext: z.object({
    firstName: z.string().optional(),
    accountNumber: z.string().optional(),
    kycTier: z.enum(["tier1", "tier2", "tier3"]).optional(),
  }).optional(),
});

/** Persistent state: long-term customer knowledge */
export const PersistentStateSchema = z.object({
  phone: z.string(),
  /** Customer profile info */
  customerProfile: z.object({
    name: z.string().optional(),
    accountNumber: z.string().optional(),
    kycStatus: z.enum(["unverified", "pending", "verified"]).default("unverified"),
    hasTransactionPin: z.boolean().default(false),
    registeredPhone: z.string().optional(),
  }).optional(),
  /** Long-term customer preferences and facts */
  knowledge: z.record(z.string(), z.any()).optional(),
  /** User preferences learned over time */
  preferences: z.object({
    preferredLanguage: z.string().default("en"),
    preferredTimeFormat: z.string().default("12h"),
    preferredCurrency: z.string().default("NGN"),
    communicationStyle: z.string().optional(),
  }).optional(),
  /** Conversation patterns and history summary */
  interactionSummary: z.object({
    totalSessions: z.number().default(0),
    lastInteraction: z.string().datetime().optional(),
    commonIntents: z.array(z.string()).optional(),
    successRate: z.number().min(0).max(1).optional(),
  }).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPLETE AGENT STATE
// ─────────────────────────────────────────────────────────────────────────────

export const AgentStateSchema = z.object({
  // Ephemeral (current message processing)
  ephemeral: EphemeralStateSchema.optional(),
  
  // Session (current conversation)
  session: SessionStateSchema,
  
  // Persistent (long-term knowledge)
  persistent: PersistentStateSchema,
  
  // Metadata
  stateVersion: z.string().default("1.0"),
  lastUpdated: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export type EphemeralState = z.infer<typeof EphemeralStateSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;
export type PersistentState = z.infer<typeof PersistentStateSchema>;
export type AgentState = z.infer<typeof AgentStateSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// STATE FACTORIES & UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create initial empty agent state for a new customer session
 */
export function createInitialAgentState(phone: string): AgentState {
  const now = new Date().toISOString();
  return {
    session: {
      phone,
      conversationHistory: [],
      currentStep: 0,
      toolsUsed: [],
    },
    persistent: {
      phone,
      customerProfile: {
        kycStatus: "unverified",
        hasTransactionPin: false,
      },
      knowledge: {},
      preferences: {
        preferredLanguage: "en",
        preferredTimeFormat: "12h",
        preferredCurrency: "NGN",
      },
      interactionSummary: {
        totalSessions: 0,
      },
    },
    stateVersion: "1.0",
    lastUpdated: now,
    createdAt: now,
  };
}

/**
 * Validate agent state against schema
 */
export function validateAgentState(state: unknown): { valid: boolean; errors?: string[] } {
  const result = AgentStateSchema.safeParse(state);
  if (!result.success) {
    return {
      valid: false,
      errors: result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`),
    };
  }
  return { valid: true };
}

/**
 * Create a snapshot of current state for logging/debugging
 */
export function createStateSnapshot(state: AgentState): Record<string, any> {
  return {
    timestamp: new Date().toISOString(),
    phone: state.session.phone,
    currentGoal: state.session.currentGoal?.action,
    goalStatus: state.session.currentGoal?.status,
    taskProgress: `${state.session.currentStep}/${state.session.taskPlan?.length ?? 0}`,
    conversationTurns: state.session.conversationHistory.length,
    toolsUsed: state.session.toolsUsed,
    workingMemoryKeys: Object.keys(state.session.workingMemory ?? {}),
    detectedIntent: state.ephemeral?.detectedIntent,
  };
}

/**
 * Extract conversation context for LLM (subject to token limits)
 */
export function extractConversationContext(state: AgentState, maxTurns = 5): Array<{ role: string; content: string }> {
  const history = state.session.conversationHistory ?? [];
  if (history.length <= maxTurns) {
    return history.map(h => ({ role: h.role, content: h.content }));
  }
  // Keep system context and last N turns
  return history.slice(-maxTurns).map(h => ({ role: h.role, content: h.content }));
}

/**
 * Build a context summary string for the LLM (lightweight alternative to full history)
 */
export function buildContextSummary(state: AgentState): string {
  const session = state.session;
  const goal = session.currentGoal;
  const profile = state.persistent.customerProfile;
  
  let summary = "";
  
  if (profile?.name) {
    summary += `Customer: ${profile.name}\n`;
  }
  
  if (goal) {
    summary += `Current Goal: ${goal.action} (${goal.status})\n`;
    if (session.taskPlan) {
      const completedSteps = session.taskPlan.filter(s => s.status === "completed").length;
      summary += `Progress: Step ${session.currentStep + 1} of ${session.taskPlan.length} (${completedSteps} completed)\n`;
    }
  }
  
  if (session.workingMemory && Object.keys(session.workingMemory).length > 0) {
    summary += `Active Data:\n`;
    Object.entries(session.workingMemory).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        summary += `  - ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}\n`;
      }
    });
  }
  
  return summary;
}

/**
 * Get list of tools relevant to current goal
 */
export function getRelevantTools(state: AgentState): string[] {
  const goal = state.session.currentGoal?.action;
  
  const toolsByGoal: Record<string, string[]> = {
    balance: ["balance_enquiry", "verify_pin"],
    mini_statement: ["mini_statement", "verify_pin"],
    transfer: ["resolve_account", "lookup_recipient", "intra_transfer", "verify_pin", "send_otp", "verify_otp"],
    bill_payment: ["validate_biller", "bill_payment", "verify_pin", "send_otp", "verify_otp"],
    kyc: ["send_kyc_verification", "verify_kyc"],
    unknown: [],
  };
  
  return toolsByGoal[goal ?? "unknown"] ?? [];
}
