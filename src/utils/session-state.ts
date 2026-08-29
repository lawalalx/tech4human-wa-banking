import { Pool } from "pg";
import { normalizePhone } from "./format-phone";

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
  const normalizedPhone = normalizePhone(phone);
  const { rows } = await pool.query(
    `SELECT phone, customer_name, account_number, kyc_status, state, authenticated,
            last_active, updated_at, context
     FROM customer_sessions
     WHERE phone = $1
     LIMIT 1`,
    [normalizedPhone]
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
  const normalizedPhone = normalizePhone(phone);

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
    [normalizedPhone, stateMap[flow.action] || "awaiting_otp", JSON.stringify(flow)]
  );
}

/**
 * Clear any pending flow — call this when a flow completes successfully or is abandoned.
 */
export async function clearPendingFlow(phone: string): Promise<void> {
  const normalizedPhone = normalizePhone(phone);

  await pool.query(
    `UPDATE customer_sessions
     SET state       = 'idle',
         context     = context - 'pending_flow',
         last_active = NOW(),
         updated_at  = NOW()
     WHERE phone = $1`,
    [normalizedPhone]
  );
}

/**
 * Update the last_active timestamp for a customer session.
 * Call this on every inbound message to track customer activity.
 */
export async function touchSession(phone: string): Promise<void> {
  const normalizedPhone = normalizePhone(phone);

  await pool.query(
    `UPDATE customer_sessions
     SET last_active = NOW(), updated_at = NOW()
     WHERE phone = $1`,
    [normalizedPhone]
  );
}

export async function setServiceTermsPrompted(phone: string): Promise<void> {
  const normalizedPhone = normalizePhone(phone);
  await pool.query(
    `INSERT INTO customer_sessions (phone, state, context, last_active)
     VALUES ($1, 'idle', $2::jsonb, NOW())
     ON CONFLICT (phone) DO UPDATE
       SET context     = customer_sessions.context || $2::jsonb,
           last_active = NOW(),
           updated_at  = NOW()`,
    [normalizedPhone, JSON.stringify({ service_terms_prompted: true })]
  );
}

export async function setServiceTermsAccepted(phone: string): Promise<void> {
  const normalizedPhone = normalizePhone(phone);
  await pool.query(
    `INSERT INTO customer_sessions (phone, state, context, last_active)
     VALUES ($1, 'idle', $2::jsonb, NOW())
     ON CONFLICT (phone) DO UPDATE
       SET context     = customer_sessions.context || $2::jsonb,
           last_active = NOW(),
           updated_at  = NOW()`,
    [normalizedPhone, JSON.stringify({ service_terms_prompted: true, service_terms_accepted: true })]
  );
}

export async function hasAcceptedServiceTerms(phone: string): Promise<boolean> {
  const normalizedPhone = normalizePhone(phone);
  const session = await getSessionState(normalizedPhone);
  return Boolean(session?.context?.service_terms_accepted === true);
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

/**
 * ── Account Linking helpers ──────────────────────────────────────────────────
 *
 * The linked account details are persisted in `customer_sessions`:
 *   - `account_number` column  ← the plain account number (for transactions)
 *   - `context` JSONB          ← { account: { maskedAccount, accountType } }
 *
 * `hasAcceptedServiceTerms` already uses column `account_number`, so we reuse
 * it here to detect whether an account has been linked at all.
 */

export interface LinkedAccount {
  accountNumber: string;
  account_number?: string;
  maskedAccount: string;
  accountType: string;
}

/**
 * Check whether the customer already has a linked bank account on the session.
 */
export async function hasLinkedAccount(phone: string): Promise<boolean> {
  const normalizedPhone = normalizePhone(phone);
  const session = await getSessionState(normalizedPhone);
  return Boolean(session?.account_number);
}

/**
 * Awaiting-Resume bookkeeping
 * ───────────────────────────
 * When the bot sends the customer a Meta Flow (link-account or set-pin), the
 * customer's ORIGINAL request cannot proceed until the flow is completed.
 * We persist the original request here so that when the flow completes
 * (nfm_reply event or the customer typing "Done") we can deterministically
 * resume it instead of relying on the LLM to figure out what "Done" means.
 */
export interface AwaitingResume {
  /** Which flow the customer was sent to complete */
  kind: "link" | "pin";
  /** The customer's original request text (e.g. "Balance") */
  originalRequest: string;
  /** ISO timestamp when the flow was sent */
  at: string;
}

export async function setAwaitingResume(
  phone: string,
  kind: "link" | "pin",
  originalRequest: string
): Promise<void> {
  const normalizedPhone = normalizePhone(phone);
  const payload: AwaitingResume = {
    kind,
    originalRequest,
    at: new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO customer_sessions (phone, state, context, last_active)
     VALUES ($1, 'idle', jsonb_build_object('awaiting_resume', $2::jsonb), NOW())
     ON CONFLICT (phone) DO UPDATE
       SET context    = customer_sessions.context || jsonb_build_object('awaiting_resume', $2::jsonb),
           last_active = NOW(),
           updated_at  = NOW()`,
    [normalizedPhone, JSON.stringify(payload)]
  );
}

/**
 * Read and CLEAR the awaiting-resume marker.
 * Returns null when there is nothing to resume.
 */
export async function popAwaitingResume(phone: string): Promise<AwaitingResume | null> {
  const normalizedPhone = normalizePhone(phone);
  const { rows } = await pool.query(
    `SELECT context -> 'awaiting_resume' AS resume
     FROM customer_sessions
     WHERE phone = $1`,
    [normalizedPhone]
  );
  const resume = rows[0]?.resume as AwaitingResume | null | undefined;
  if (!resume || !resume.originalRequest) return null;

  await pool.query(
    `UPDATE customer_sessions
     SET context    = context - 'awaiting_resume',
         updated_at = NOW()
     WHERE phone = $1`,
    [normalizedPhone]
  );
  return {
    kind: resume.kind === "pin" ? "pin" : "link",
    originalRequest: String(resume.originalRequest),
    at: String(resume.at || ""),
  };
}

/**
 * Record that the flow-completion auto-resume already fired (e.g. from the
 * data_exchange webhook fallback). Used to suppress duplicate nfm_reply
 * confirmations if both the webhook and the nfm_reply event arrive.
 */
export async function markFlowAutoResumed(phone: string): Promise<void> {
  const normalizedPhone = normalizePhone(phone);
  await pool.query(
    `INSERT INTO customer_sessions (phone, state, context, last_active)
     VALUES ($1, 'idle', jsonb_build_object('last_flow_resume_at', $2::text), NOW())
     ON CONFLICT (phone) DO UPDATE
       SET context    = customer_sessions.context || jsonb_build_object('last_flow_resume_at', $2::text),
           last_active = NOW(),
           updated_at  = NOW()`,
    [normalizedPhone, new Date().toISOString()]
  );
}

/** True when a flow-completion auto-resume happened within `windowMs`. */
export async function wasRecentlyAutoResumed(phone: string, windowMs = 60_000): Promise<boolean> {
  const normalizedPhone = normalizePhone(phone);
  const { rows } = await pool.query(
    `SELECT context -> 'last_flow_resume_at' AS t FROM customer_sessions WHERE phone = $1`,
    [normalizedPhone]
  );
  const raw = rows[0]?.t as string | null | undefined;
  if (!raw) return false;
  const at = new Date(raw).getTime();
  if (Number.isNaN(at)) return false;
  return Date.now() - at <= windowMs;
}

/**
 * Data-exchange auto-resume (fallback when the nfm_reply event is dropped):
 * persist a ready-made AUTO-RESUME note so the very next pipeline pass injects
 * it into the supervisor prompt — the LLM becomes step-aware without any
 * synthetic-webhook gymnastics.
 */
export async function setAutoResumeNote(phone: string, note: string): Promise<void> {
  const normalizedPhone = normalizePhone(phone);
  await pool.query(
    `INSERT INTO customer_sessions (phone, state, context, last_active)
     VALUES ($1, 'idle', jsonb_build_object('auto_resume_note', $2::text), NOW())
     ON CONFLICT (phone) DO UPDATE
       SET context    = customer_sessions.context || jsonb_build_object('auto_resume_note', $2::text),
           last_active = NOW(),
           updated_at  = NOW()`,
    [normalizedPhone, note]
  );
}

/** Read and CLEAR the stored auto-resume note. */
export async function popAutoResumeNote(phone: string): Promise<string | null> {
  const normalizedPhone = normalizePhone(phone);
  const { rows } = await pool.query(
    `SELECT context -> 'auto_resume_note' AS note FROM customer_sessions WHERE phone = $1`,
    [normalizedPhone]
  );
  const note = rows[0]?.note as string | null | undefined;
  if (!note) return null;
  await pool.query(
    `UPDATE customer_sessions
     SET context    = context - 'auto_resume_note',
         updated_at = NOW()
     WHERE phone = $1`,
    [normalizedPhone]
  );
  return note;
}

/**
 * Retrieve the linked account details (masked number + type + plain number)
 * from the session, or null if none is linked.
 */
export async function getLinkedAccount(phone: string): Promise<LinkedAccount | null> {
  const normalizedPhone = normalizePhone(phone);

  console.log(`🔍 [getLinkedAccount] Querying DB for normalized phone: "${normalizedPhone}"`);

  const session = await getSessionState(normalizedPhone);
  console.log(`🔍 [getLinkedAccount] Found session account_number: "${session?.account_number || null}"`);

  if (!session?.account_number) return null;

  const ctxAccount = session.context?.account as Partial<LinkedAccount> | undefined;
  return {
    accountNumber: session.account_number,
    maskedAccount: ctxAccount?.maskedAccount ?? session.account_number.slice(-4).padStart(session.account_number.length, "*"),
    accountType: ctxAccount?.accountType ?? "current",
  };
}

/**
 * Persist the linked account so that subsequent tools can resolve it from the
 * session instead of re-querying the backend on every interaction.
 */
export async function setLinkedAccount(phone: string, account: LinkedAccount): Promise<void> {
  const normalizedPhone = normalizePhone(phone);

  console.log(`💾 [setLinkedAccount] Saving account "${account.accountNumber}" to normalized phone: "${normalizedPhone}"`);
  
  await pool.query(
    `INSERT INTO customer_sessions (phone, account_number, state, context, last_active)
     VALUES ($1, $2, 'idle', $3::jsonb, NOW())
     ON CONFLICT (phone) DO UPDATE
       SET account_number = EXCLUDED.account_number,
           context        = customer_sessions.context || $3::jsonb,
           last_active    = NOW(),
           updated_at     = NOW()`,
    [normalizedPhone, account.accountNumber, JSON.stringify({ account: { maskedAccount: account.maskedAccount, accountType: account.accountType } })]
  );
  const verify = await pool.query(
    `SELECT account_number FROM customer_sessions WHERE phone = $1`, 
    [normalizedPhone]
  );
  console.log(`\n\n🔍 [DIAGNOSTIC] Read back immediately after save:`, verify.rows[0]);
}

/**
 * Retrieve ALL bank accounts linked to this phone number.
 * Primary source: customer_sessions.account_number (set by the link-account flow).
 * Additional accounts come from verified_customers rows captured for the same phone.
 */
export async function getAllLinkedAccounts(phone: string): Promise<LinkedAccount[]> {
  const normalizedPhone = normalizePhone(phone);
  const accounts = new Map<string, LinkedAccount>();
  const primary = await getLinkedAccount(normalizedPhone);
  if (primary) accounts.set(primary.accountNumber, primary);

  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT account_number FROM verified_customers WHERE phone_number = $1`,
      [normalizedPhone]
    );
    for (const row of rows) {
      const acctNum = String(row.account_number || "");
      if (!acctNum || accounts.has(acctNum)) continue;
      accounts.set(acctNum, {
        accountNumber: acctNum,
        maskedAccount: acctNum.slice(0, 3) + "****" + acctNum.slice(-4),
        accountType: "current",
      });
    }
  } catch (err) {
    console.error("[session-state] getAllLinkedAccounts secondary lookup failed:", err);
  }

  return Array.from(accounts.values());
}
