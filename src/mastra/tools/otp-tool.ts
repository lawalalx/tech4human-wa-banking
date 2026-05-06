import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { sendWhatsAppText } from "../../whatsapp-client.js";
import { Pool } from "pg";
import crypto from "crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function generateOtp(length = 6): string {
  const digits = "0123456789";
  let otp = "";
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    otp += digits[bytes[i] % 10];
  }
  return otp;
}

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp + process.env.OTP_SALT || "t4h_salt").digest("hex");
}

/**
 * Generates and sends an OTP to the customer's phone via SMS.
 * Records the hashed OTP in the database.
 */
export const sendOtpTool = createTool({
  id: "send-otp",
  description:
    "Generate and send a 6-digit OTP to the customer's registered phone number for 2FA. " +
    "Use before any financial transaction or sensitive operation. " +
    "Returns an otpId to use with the verify-otp tool.",
  inputSchema: z.object({
    phone: z.string().describe("Customer's WhatsApp phone number"),
    purpose: z
      .enum(["login", "transaction", "device_binding", "kyc"])
      .describe("What this OTP is for"),
  }),
  outputSchema: z.object({
    sent: z.boolean(),
    otpId: z.string().optional(),
    expiresIn: z.number().describe("OTP expiry in minutes"),
  }),
  execute: async ({ phone, purpose }: { phone: string; purpose: string }) => {
    const otp = generateOtp(6);
    const otpHash = hashOtp(otp);
    const expiryMinutes = Number(process.env.OTP_EXPIRY_MINUTES) || 5;
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    const client = await pool.connect();
    let otpId: string | undefined;
    try {
      const result = await client.query(
        `INSERT INTO otp_records (phone, otp_hash, purpose, expires_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [phone, otpHash, purpose, expiresAt]
      );
      otpId = String(result.rows[0].id);
    } finally {
      client.release();
    }

    // Send OTP via WhatsApp (in production, use SMS provider)
    const purposeLabel: Record<string, string> = {
      login: "log in",
      transaction: "confirm your transaction",
      device_binding: "register your device",
      kyc: "verify your identity",
    };
    const message =
      `🔐 Your ${process.env.BANK_NAME || "bank"} verification code is: *${otp}*\n\n` +
      `Use this code to ${purposeLabel[purpose] || purpose}.\n` +
      `Valid for ${expiryMinutes} minutes. Do NOT share with anyone.`;

    await sendWhatsAppText(phone, message);
    console.log(`[OTP] Sent OTP to ${phone} for purpose: ${purpose} (ID: ${otpId})`);

    return { sent: true, otpId, expiresIn: expiryMinutes };
  },
});

/**
 * Verifies an OTP entered by the customer.
 */
export const verifyOtpTool = createTool({
  id: "verify-otp",
  description:
    "Verify a 6-digit OTP that the customer entered. " +
    "Call this after the customer replies with their OTP code. " +
    "Returns verified: true if valid, or an error reason if invalid.",
  inputSchema: z.object({
    phone: z.string().describe("Customer's phone number"),
    otp: z.string().describe("The OTP code the customer entered"),
    otpId: z.string().describe("The otpId returned by send-otp"),
  }),
  outputSchema: z.object({
    verified: z.boolean(),
    reason: z.string().optional().describe("Reason for failure if not verified"),
    attemptsRemaining: z.number().optional(),
  }),
  execute: async ({ phone, otp, otpId }: { phone: string; otp: string; otpId: string }) => {
    const maxAttempts = Number(process.env.MAX_OTP_ATTEMPTS) || 3;
    const otpHash = hashOtp(otp.trim());
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id, otp_hash, expires_at, attempts, used
         FROM otp_records
         WHERE id = $1 AND phone = $2`,
        [otpId, phone]
      );

      if (result.rows.length === 0) {
        return { verified: false, reason: "OTP record not found." };
      }

      const record = result.rows[0];

      if (record.used) {
        return { verified: false, reason: "This OTP has already been used." };
      }
      if (new Date(record.expires_at) < new Date()) {
        return { verified: false, reason: "OTP has expired. Please request a new one." };
      }
      if (record.attempts >= maxAttempts) {
        return { verified: false, reason: "Maximum attempts exceeded. Please request a new OTP." };
      }

      // Increment attempts
      await client.query(`UPDATE otp_records SET attempts = attempts + 1 WHERE id = $1`, [otpId]);

      if (record.otp_hash !== otpHash) {
        const remaining = maxAttempts - record.attempts - 1;
        return {
          verified: false,
          reason: `Incorrect OTP. ${remaining} attempt(s) remaining.`,
          attemptsRemaining: remaining,
        };
      }

      // Mark as used
      await client.query(`UPDATE otp_records SET used = true WHERE id = $1`, [otpId]);
      return { verified: true };
    } finally {
      client.release();
    }
  },
});
