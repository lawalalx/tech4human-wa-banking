/**
 * Legacy Session State Adapter
 * 
 * Bridges existing `session-state.ts` with new `AgentState` model
 * Maintains backward compatibility while enabling gradual migration
 */

import { AgentState, createInitialAgentState } from "./agent-state.js";
import { Pool } from "pg";

type GoalStatus = NonNullable<AgentState["session"]["currentGoal"]>["status"];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function toDbPhoneKey(phone: string): string {
  const normalized = String(phone || "").trim();
  if (normalized.length <= 20) return normalized;
  // Keep a stable compact key for synthetic/non-E164 IDs while fitting DB varchar(20).
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return `id_${hash.toString(36)}`.slice(0, 20);
}

// ─────────────────────────────────────────────────────────────────────
// ADAPTER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────

/**
 * Load legacy pending_flow from database and convert to AgentState
 */
export async function loadAgentStateFromLegacyDB(phone: string): Promise<AgentState | null> {
  try {
    const dbPhoneKey = toDbPhoneKey(phone);
    const { rows } = await pool.query(
      `SELECT customer_name, account_number, kyc_status, state, authenticated,
              last_active, context
       FROM customer_sessions
       WHERE phone = $1
       LIMIT 1`,
      [dbPhoneKey]
    );
    
    if (!rows.length) return null;
    
    const row = rows[0];
    const context = row.context || {};
    const pendingFlow = context.pending_flow;
    
    // Convert legacy session to new AgentState
    const agentState = createInitialAgentState(phone);
    
    // Restore customer profile
    agentState.persistent.customerProfile = {
      name: row.customer_name,
      accountNumber: row.account_number,
      kycStatus: row.kyc_status || "unverified",
      hasTransactionPin: (context.hasTransactionPin ?? false),
      registeredPhone: (context.registeredPhone as string | undefined),
    };
    
    // Restore pending goal if exists
    if (pendingFlow) {
      agentState.session.currentGoal = {
        action: pendingFlow.action,
        description: `Pending ${pendingFlow.action}`,
        status: mapLegacyStepToStatus(pendingFlow.step),
        startedAt: pendingFlow.started_at,
      };
      
      // Restore working memory from pending data
      agentState.session.workingMemory = pendingFlow.data;
    }
    
    agentState.session.conversationHistory = [];
    agentState.lastUpdated = new Date().toISOString();
    
    return agentState;
  } catch (error) {
    console.error(`[Adapter] Error loading state for ${phone}:`, error);
    return null;
  }
}

/**
 * Save new AgentState back to legacy database schema
 */
export async function saveAgentStateToLegacyDB(state: AgentState): Promise<void> {
  try {
    const dbPhoneKey = toDbPhoneKey(state.session.phone);
    const profile = state.persistent.customerProfile;
    const goal = state.session.currentGoal;
    const { rows } = await pool.query(
      `SELECT context
       FROM customer_sessions
       WHERE phone = $1
       LIMIT 1`,
      [dbPhoneKey]
    );
    const existingContext = (rows[0]?.context || {}) as Record<string, unknown>;
    
    // Build legacy pending_flow if goal exists
    const pendingFlowFromGoal = goal ? {
      action: goal.action,
      step: mapStatusToLegacyStep(goal.status),
      data: state.session.workingMemory || {},
      started_at: goal.startedAt,
    } : null;
    const effectivePendingFlow = pendingFlowFromGoal ?? existingContext.pending_flow ?? null;
    
    const context = {
      ...existingContext,
      pending_flow: effectivePendingFlow,
      hasTransactionPin: profile?.hasTransactionPin ?? false,
      registeredPhone: profile?.registeredPhone,
      conversation_count: state.session.conversationHistory.length,
    };
    
    await pool.query(
      `INSERT INTO customer_sessions 
       (phone, customer_name, account_number, kyc_status, state, authenticated, context, last_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
       ON CONFLICT (phone) DO UPDATE
       SET customer_name = $2,
           account_number = $3,
           kyc_status = $4,
           state = $5,
           authenticated = $6,
           context = $7::jsonb,
           last_active = NOW(),
           updated_at = NOW()`,
      [
        dbPhoneKey,
        profile?.name || null,
        profile?.accountNumber || null,
        profile?.kycStatus || "unverified",
        effectivePendingFlow ? "pending" : "idle",
        profile?.kycStatus === "verified",
        JSON.stringify(context),
      ]
    );
  } catch (error) {
    console.error(`[Adapter] Error saving state for ${state.session.phone}:`, error);
    // Do not fail customer-facing requests when legacy persistence writes fail.
    return;
  }
}

/**
 * Map legacy step names to new goal status
 */
function mapLegacyStepToStatus(step: string): GoalStatus {
  const mapping: Record<string, GoalStatus> = {
    "awaiting_transfer_details": "in_progress",
    "awaiting_transfer_confirmation": "pending_confirmation",
    "awaiting_pin": "pending_pin",
    "awaiting_otp": "pending_otp",
    "awaiting_new_pin": "pending_pin",
    "awaiting_bill_details": "in_progress",
    "awaiting_bill_final_confirmation": "pending_confirmation",
    "awaiting_phone_verification": "in_progress",
  };
  
  return mapping[step] || "in_progress";
}

/**
 * Map new goal status back to legacy step names
 */
function mapStatusToLegacyStep(status: string): string {
  const mapping: Record<string, string> = {
    "pending_pin": "awaiting_pin",
    "pending_otp": "awaiting_otp",
    "pending_confirmation": "awaiting_transfer_confirmation",
    "in_progress": "awaiting_transfer_details",
  };
  
  return mapping[status] || "awaiting_transfer_details";
}

/**
 * Helper to get legacy session state (for backward compatibility)
 * Used by existing code that expects PendingFlow
 */
export async function getLegacyPendingFlow(phone: string) {
  const state = await loadAgentStateFromLegacyDB(phone);
  if (!state || !state.session.currentGoal) return undefined;
  
  return {
    action: state.session.currentGoal.action,
    step: mapStatusToLegacyStep(state.session.currentGoal.status),
    data: state.session.workingMemory || {},
    started_at: state.session.currentGoal.startedAt,
  };
}

/**
 * Initialize database schema for AgentState if needed
 * (for future migrations)
 */
export async function ensureAgentStateTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_states (
      phone TEXT PRIMARY KEY,
      ephemeral JSONB,
      session JSONB NOT NULL,
      persistent JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      last_accessed TIMESTAMP DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_agent_states_updated_at ON agent_states(updated_at);
  `);
}
