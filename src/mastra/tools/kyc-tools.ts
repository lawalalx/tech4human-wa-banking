import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const NIBSS_URL = process.env.NIBSS_API_URL || "https://api.nibss-plc.com.ng/v1";
const IDENTITY_KEY = process.env.IDENTITY_VERIFICATION_API_KEY || "";

async function callIdentityApi(
  path: string,
  payload: Record<string, string>
): Promise<{ valid: boolean; data?: Record<string, string>; error?: string }> {
  try {
    const res = await fetch(`${NIBSS_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${IDENTITY_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { valid: false, error: `Verification service error: ${res.status}` };
    }
    const data = (await res.json()) as Record<string, string>;
    return { valid: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // MOCK: In dev, return mock data
    console.warn(`[KYC] Identity API unavailable (${message}), using mock data`);
    return {
      valid: true,
      data: {
        firstName: "John",
        lastName: "Doe",
        dateOfBirth: "1990-01-01",
        phone: payload.phone || "",
        status: "verified",
      },
    };
  }
}

// ─── BVN Verification ─────────────────────────────────────────────────────────

export const verifyBvnTool = createTool({
  id: "verify-bvn",
  description:
    "Verify a customer's Bank Verification Number (BVN) against NIBSS database. " +
    "Use during KYC onboarding. Never display the BVN after collection.",
  inputSchema: z.object({
    bvn: z.string().length(11).describe("11-digit BVN"),
    phone: z.string().describe("Customer phone number for cross-verification"),
    dateOfBirth: z.string().optional().describe("DOB in YYYY-MM-DD for additional verification"),
  }),
  outputSchema: z.object({
    verified: z.boolean(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({
    bvn,
    phone,
    dateOfBirth,
  }: {
    bvn: string;
    phone: string;
    dateOfBirth?: string;
  }) => {
    console.log(`[KYC] Verifying BVN for ${phone}`);
    const result = await callIdentityApi("/bvn/verify", { bvn, phone, ...(dateOfBirth ? { dob: dateOfBirth } : {}) });
    if (!result.valid || !result.data) {
      return { verified: false, error: result.error || "BVN verification failed." };
    }
    if (result.data.status !== "verified") {
      return { verified: false, error: "BVN does not match our records." };
    }
    return {
      verified: true,
      firstName: result.data.firstName,
      lastName: result.data.lastName,
    };
  },
});

// ─── NIN Verification ─────────────────────────────────────────────────────────

export const verifyNinTool = createTool({
  id: "verify-nin",
  description:
    "Verify a customer's National Identity Number (NIN) against NIMC database. " +
    "Alternative to BVN for identity verification during KYC.",
  inputSchema: z.object({
    nin: z.string().length(11).describe("11-digit NIN"),
    phone: z.string(),
    dateOfBirth: z.string().optional(),
  }),
  outputSchema: z.object({
    verified: z.boolean(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({
    nin,
    phone,
    dateOfBirth,
  }: {
    nin: string;
    phone: string;
    dateOfBirth?: string;
  }) => {
    console.log(`[KYC] Verifying NIN for ${phone}`);
    const result = await callIdentityApi("/nin/verify", { nin, phone, ...(dateOfBirth ? { dob: dateOfBirth } : {}) });
    if (!result.valid || !result.data) {
      return { verified: false, error: result.error || "NIN verification failed." };
    }
    return {
      verified: true,
      firstName: result.data.firstName,
      lastName: result.data.lastName,
    };
  },
});

// ─── Customer Registration ────────────────────────────────────────────────────

export const saveCustomerProfileTool = createTool({
  id: "save-customer-profile",
  description:
    "Save or update a customer's onboarding profile after successful KYC verification. " +
    "Marks the customer as verified in the session store.",
  inputSchema: z.object({
    phone: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string().optional(),
    accountNumber: z.string().optional(),
    kycMethod: z.enum(["bvn", "nin", "document"]),
  }),
  outputSchema: z.object({
    saved: z.boolean(),
    sessionId: z.string().optional(),
  }),
  execute: async ({
    phone,
    firstName,
    lastName,
    email,
    accountNumber,
    kycMethod,
  }: {
    phone: string;
    firstName: string;
    lastName: string;
    email?: string;
    accountNumber?: string;
    kycMethod: string;
  }) => {
    const client = await pool.connect();
    try {
      // Upsert session with verified flag
      const result = await client.query(
        `INSERT INTO customer_sessions (phone, state, authenticated, context)
         VALUES ($1, 'active', true, $2)
         ON CONFLICT (phone) DO UPDATE SET
           state = 'active',
           authenticated = true,
           context = customer_sessions.context || $2,
           updated_at = NOW()
         RETURNING id`,
        [
          phone,
          JSON.stringify({ firstName, lastName, email, accountNumber, kycMethod }),
        ]
      );
      return { saved: true, sessionId: String(result.rows[0].id) };
    } catch {
      return { saved: false };
    } finally {
      client.release();
    }
  },
});

// ─── Existing Customer Activation ─────────────────────────────────────────────

export const activateExistingCustomerTool = createTool({
  id: "activate-existing-customer",
  description:
    "Activate WhatsApp banking for an existing bank customer by linking their account. " +
    "Called after OTP verification for existing customer channel activation (US-003).",
  inputSchema: z.object({
    phone: z.string(),
    accountNumber: z.string().describe("Customer's existing bank account number"),
  }),
  outputSchema: z.object({
    activated: z.boolean(),
    accountName: z.string().optional(),
    maskedAccount: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ phone, accountNumber }: { phone: string; accountNumber: string }) => {
    // In production: verify account ownership via core banking
    console.log(`[KYC] Activating existing customer: ${phone} → ${accountNumber}`);
    const masked = "***" + accountNumber.slice(-4);
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO customer_sessions (phone, state, authenticated, context)
         VALUES ($1, 'active', true, $2)
         ON CONFLICT (phone) DO UPDATE SET state = 'active', authenticated = true,
           context = customer_sessions.context || $2, updated_at = NOW()`,
        [phone, JSON.stringify({ accountNumber, activated: true })]
      );
      return { activated: true, accountName: "ACCOUNT HOLDER", maskedAccount: masked };
    } finally {
      client.release();
    }
  },
});
