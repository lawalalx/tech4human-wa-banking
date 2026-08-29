/**
 * Transaction PIN Vault — local PostgreSQL storage with scrypt hashing.
 *
 * PINs are NEVER stored in plaintext:
 *   hash = scrypt(pin, salt, 32) stored as hex alongside a random 16-byte salt.
 *
 * Verification enforces a max-attempt lockout (default 3 attempts → 15 min lock)
 * to match typical banking security expectations.
 */
import crypto from "crypto";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const MAX_ATTEMPTS = 3;
const LOCK_MINUTES = 15;

function hashPin(pin: string, saltHex: string): string {
  return crypto.scryptSync(pin, Buffer.from(saltHex, "hex"), 32).toString("hex");
}

export interface PinVerificationResult {
  verified: boolean;
  hasPin: boolean;
  attemptsRemaining?: number;
  blocked?: boolean;
  lockedMinutesRemaining?: number;
}

/** Check whether the phone number has a transaction PIN set. */
export async function hasTransactionPin(phone: string): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM customer_pins WHERE phone = $1 LIMIT 1`,
      [phone]
    );
    return rows.length > 0;
  } catch (err) {
    console.error("[pin-store] hasTransactionPin failed:", err);
    return false;
  }
}

/**
 * Save (or overwrite) the transaction PIN for a phone number.
 * Overwriting resets attempt counters and clears any lock.
 */
export async function saveTransactionPin(phone: string, pin: string): Promise<boolean> {
  try {
    const salt = crypto.randomBytes(16).toString("hex");
    const pinHash = hashPin(pin, salt);
    await pool.query(
      `INSERT INTO customer_pins (phone, pin_hash, salt, attempts, locked_until)
       VALUES ($1, $2, $3, 0, NULL)
       ON CONFLICT (phone) DO UPDATE
         SET pin_hash     = EXCLUDED.pin_hash,
             salt         = EXCLUDED.salt,
             attempts     = 0,
             locked_until = NULL,
             updated_at   = NOW()`,
      [phone, pinHash, salt]
    );
    return true;
  } catch (err) {
    console.error("[pin-store] saveTransactionPin failed:", err);
    return false;
  }
}

/**
 * Verify a PIN against the vault.
 * - Locks the record after MAX_ATTEMPTS consecutive failures.
 * - While locked, verification is refused until the lock expires.
 */
export async function verifyStoredPin(phone: string, pin: string): Promise<PinVerificationResult> {
  try {
    const { rows } = await pool.query(
      `SELECT pin_hash, salt, attempts, locked_until FROM customer_pins WHERE phone = $1 LIMIT 1`,
      [phone]
    );
    if (!rows.length) return { verified: false, hasPin: false };

    const row = rows[0];
    const lockedUntil = row.locked_until ? new Date(row.locked_until) : null;

    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      const minsLeft = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60000));
      return { verified: false, hasPin: true, blocked: true, lockedMinutesRemaining: minsLeft, attemptsRemaining: 0 };
    }
    if (lockedUntil && lockedUntil.getTime() <= Date.now()) {
      // Lock expired — reset counter
      await pool.query(`UPDATE customer_pins SET attempts = 0, locked_until = NULL WHERE phone = $1`, [phone]);
      row.attempts = 0;
    }

    const ok = crypto.timingSafeEqual(
      Buffer.from(hashPin(pin, row.salt), "hex"),
      Buffer.from(row.pin_hash, "hex")
    );
    if (ok) {
      await pool.query(`UPDATE customer_pins SET attempts = 0, locked_until = NULL WHERE phone = $1`, [phone]);
      return { verified: true, hasPin: true };
    }

    const attempts = Number(row.attempts || 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await pool.query(
        `UPDATE customer_pins SET attempts = $2, locked_until = NOW() + INTERVAL '${LOCK_MINUTES} minutes' WHERE phone = $1`,
        [phone, attempts]
      );
      return { verified: false, hasPin: true, blocked: true, attemptsRemaining: 0 };
    }

    await pool.query(`UPDATE customer_pins SET attempts = $2 WHERE phone = $1`, [phone, attempts]);
    return { verified: false, hasPin: true, attemptsRemaining: MAX_ATTEMPTS - attempts };
  } catch (err) {
    console.error("[pin-store] verifyStoredPin failed:", err);
    return { verified: false, hasPin: false };
  }
}