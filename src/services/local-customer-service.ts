/**
 * Local Customer Service — the single source of truth for customer and
 * onboarding lookups. 100% LOCAL:
 *   - PostgreSQL: customer_sessions, customer_pins, verified_customers
 *   - Mock-bank HTTP API: src/bank-api/external/register.ts
 *
 * NOTE ON OTP: OTP verification is performed by the EXTERNAL bank API
 * (validateBankAccount → otpReference → verifyOtp during the Link-Account
 * flow). We deliberately do NOT create, store, or verify OTP codes locally —
 * there is no otp_records write anywhere in the application.
 *
 * NOTE ON PIN: PINs are handled exclusively by src/utils/pin-store.ts
 * (scrypt + per-customer salt, timing-safe compare). Never plaintext.
 */
import { Pool } from "pg";
import { normalizePhone } from "../utils/format-phone.js";
import { hasTransactionPin } from "../utils/pin-store.js";
import {
  getSessionState,
  hasAcceptedServiceTerms,
  setServiceTermsAccepted,
} from "../utils/session-state.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface LocalCustomerRecord {
  found: boolean;
  customer_id?: number;
  is_validated?: boolean;
  has_pin?: boolean;
  customer_name?: string;
  account_number?: string;
  message?: string;
}

/** Resolve a WhatsApp phone number to the local customer record. */
export async function lookupCustomerByPhone(rawPhone: string): Promise<LocalCustomerRecord> {
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    return { found: false, is_validated: false, has_pin: false, message: "No phone number provided." };
  }

  const hasPin = await hasTransactionPin(phone).catch(() => false);

  const { rows } = await pool.query(
    `SELECT id, customer_name, account_number
     FROM customer_sessions WHERE phone = $1 LIMIT 1`,
    [phone]
  );
  const session = rows[0];

  if (!session) {
    // No session row yet — fall back to verified_customers by phone
    const { rows: vRows } = await pool.query(
      `SELECT account_number, first_name, last_name
       FROM verified_customers WHERE phone_number = $1 LIMIT 1`,
      [phone]
    );
    if (vRows.length) {
      return {
        found: true,
        customer_id: 0,
        is_validated: true,
        has_pin: hasPin,
        customer_name: `${vRows[0].first_name ?? ""} ${vRows[0].last_name ?? ""}`.trim(),
        account_number: vRows[0].account_number,
        message: "Customer resolved from verified_customers.",
      };
    }
    return { found: false, is_validated: false, has_pin: hasPin, message: "Customer not found in the system." };
  }

  let isValidated = false;
  if (session.account_number) {
    const { rows: vRows } = await pool.query(
      `SELECT 1 FROM verified_customers WHERE account_number = $1 LIMIT 1`,
      [session.account_number]
    );
    isValidated = vRows.length > 0;
  }

  return {
    found: true,
    customer_id: Number(session.id),
    is_validated: isValidated,
    has_pin: hasPin,
    customer_name: session.customer_name ?? undefined,
    account_number: session.account_number ?? undefined,
    message: "Customer resolved from local session store.",
  };
}

/** Local onboarding status — T&C acceptance + phone/account verification flags. */
export async function getOnboardingStatus(rawPhone: string): Promise<{
  success: boolean;
  terms_accepted: boolean;
  phone_verified: boolean;
  is_fully_onboarded: boolean;
}> {
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    return { success: false, terms_accepted: false, phone_verified: false, is_fully_onboarded: false };
  }

  const [termsAccepted, session] = await Promise.all([
    hasAcceptedServiceTerms(phone).catch(() => false),
    getSessionState(phone).catch(() => null),
  ]);

  const phoneVerified = Boolean(session?.account_number);
  return {
    success: true,
    terms_accepted: termsAccepted,
    phone_verified: phoneVerified,
    is_fully_onboarded: termsAccepted && phoneVerified,
  };
}

/** Persist an onboarding flag locally (e.g. terms_accepted=true). */
export async function updateOnboardingStatus(
  rawPhone: string,
  field: string,
  value: unknown
): Promise<{ success: boolean; message: string }> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { success: false, message: "No phone number provided." };

  if (field === "terms_accepted" && (value === true || value === "true")) {
    await setServiceTermsAccepted(phone);
    return { success: true, message: "terms_accepted=true saved locally." };
  }

  // Generic context merge for any other onboarding flag
  const { rows } = await pool.query(
    `SELECT context FROM customer_sessions WHERE phone = $1 LIMIT 1`,
    [phone]
  );
  const context = (rows[0]?.context || {}) as Record<string, unknown>;
  context[field] = value;
  await pool.query(
    `INSERT INTO customer_sessions (phone, context, last_active)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (phone) DO UPDATE
       SET context = customer_sessions.context || $2::jsonb, last_active = NOW(), updated_at = NOW()`,
    [phone, JSON.stringify({ [field]: value })]
  );
  return { success: true, message: `${field} saved locally.` };
}
