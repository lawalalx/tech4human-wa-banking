import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface PendingFlow {
  /** High-level action type */
  action: "transfer" | "bill_payment" | "kyc" | "otp_verification" | "fraud_review" | "balance" | "mini_statement";
  /** Where in the flow the customer stopped */
  step: string;
  /** Serializable payload for the action (amount, recipient, biller, etc.) */
  data: Record<string, unknown>;
  /** ISO timestamp when the flow was started */
  started_at: string;
}

export interface SessionState {
  phone: string;
  customer_name?: string;
  account_number?: string;
  kyc_status: string;
  state: string;
  authenticated: boolean;
  last_active: Date;
  pending_flow?: PendingFlow;
  context: Record<string, unknown>;
}

/**
 * Fetch the current session state for a customer.
 * Returns null if no session record exists yet.
 */
export async function getSessionState(phone: string): Promise<SessionState | null> {
  const { rows } = await pool.query(
    `SELECT phone, customer_name, account_number, kyc_status, state, authenticated,
            last_active, updated_at, context
     FROM customer_sessions
     WHERE phone = $1
     LIMIT 1`,
    [phone]
  );
  if (!rows.length) return null;

  const row = rows[0];
  const context: Record<string, unknown> = row.context || {};

  return {
    phone: row.phone,
    customer_name: row.customer_name ?? undefined,
    account_number: row.account_number ?? undefined,
    kyc_status: row.kyc_status || "unverified",
    state: row.state || "idle",
    authenticated: Boolean(row.authenticated),
    last_active: row.last_active ? new Date(row.last_active) : new Date(row.updated_at),
    pending_flow: (context.pending_flow as PendingFlow) ?? undefined,
    context,
  };
}

/**
 * Record a pending flow when a multi-step action is started but not yet completed.
 * Call this when e.g. an OTP is sent for a transfer, or KYC is initiated.
 */
export async function setPendingFlow(phone: string, flow: PendingFlow): Promise<void> {
  const stateMap: Record<PendingFlow["action"], string> = {
    transfer: "pending_transfer",
    bill_payment: "pending_transfer",
    kyc: "pending_kyc",
    otp_verification: "awaiting_otp",
    fraud_review: "pending_fraud_review",
    balance: "pending_balance",
    mini_statement: "pending_statement",
  };

  await pool.query(
    `INSERT INTO customer_sessions (phone, state, context, last_active)
     VALUES ($1, $2, jsonb_build_object('pending_flow', $3::jsonb), NOW())
     ON CONFLICT (phone) DO UPDATE
       SET state       = $2,
           context     = customer_sessions.context || jsonb_build_object('pending_flow', $3::jsonb),
           last_active = NOW(),
           updated_at  = NOW()`,
    [phone, stateMap[flow.action] || "awaiting_otp", JSON.stringify(flow)]
  );
}

/**
 * Clear any pending flow — call this when a flow completes successfully or is abandoned.
 */
export async function clearPendingFlow(phone: string): Promise<void> {
  await pool.query(
    `UPDATE customer_sessions
     SET state       = 'idle',
         context     = context - 'pending_flow',
         last_active = NOW(),
         updated_at  = NOW()
     WHERE phone = $1`,
    [phone]
  );
}

/**
 * Update the last_active timestamp for a customer session.
 * Call this on every inbound message to track customer activity.
 */
export async function touchSession(phone: string): Promise<void> {
  await pool.query(
    `UPDATE customer_sessions
     SET last_active = NOW(), updated_at = NOW()
     WHERE phone = $1`,
    [phone]
  );
}

/**
 * Build the system message to inject when a customer returns with a pending flow.
 * Returns null if no resumption context is needed.
 *
 * @param session  Session state loaded from DB
 * @param resumeThresholdMs  Gap in ms after which we consider the customer as "returning"
 */
export function buildResumptionHint(
  session: SessionState,
  resumeThresholdMs = 5 * 60 * 1000
): string | null {
  if (!session.pending_flow) return null;
  if (session.state === "idle") return null;

  const gapMs = Date.now() - session.last_active.getTime();
  if (gapMs < resumeThresholdMs) return null; // Still in the same active session

  const pf = session.pending_flow;
  const gapMins = Math.round(gapMs / 60_000);
  const customerLabel = session.customer_name ? `Customer ${session.customer_name}` : "This customer";

  const actionLabel: Record<string, string> = {
    transfer: "a fund transfer",
    bill_payment: "a bill payment",
    kyc: "an identity verification (KYC)",
    otp_verification: "an OTP-authenticated action",
    fraud_review: "a fraud alert review",
    balance: "a balance enquiry",
    mini_statement: "a mini statement",
  };

  const dataLines = Object.entries(pf.data)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join("\n");

  return (
    `[SYSTEM — SESSION RESUMPTION]\n` +
    `${customerLabel} left ${gapMins} minute(s) ago with an incomplete flow:\n` +
    `  Action: ${actionLabel[pf.action] || pf.action}\n` +
    `  Step stopped at: "${pf.step}"\n` +
    `  Data collected so far:\n${dataLines}\n` +
    `  Flow started: ${pf.started_at}\n\n` +
    `Instructions:\n` +
    `1. Greet the customer warmly and acknowledge their return.\n` +
    `2. Briefly mention the pending action and ask if they want to CONTINUE or START FRESH.\n` +
    `3. If the pending action involved an OTP (step contains "otp") and more than 5 minutes have passed, ` +
    `the OTP has expired — offer to send a new one.\n` +
    `4. If the customer confirms continuation, resume from the last step using the data above.\n` +
    `5. If the customer chooses to start fresh, call clearPendingFlow or proceed with a new flow.`
  );
}
