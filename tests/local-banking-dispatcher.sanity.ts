/**
 * Local Banking Dispatcher sanity — proves callBankingTool works with NO MCP server.
 * DB-only paths are strict; outbound network paths (mock-bank sandbox) are soft.
 */
import "dotenv/config";
import { Pool } from "pg";
import { callBankingTool } from "../src/mastra/core/mcp/banking-mcp-client.js";
import { runWithRequestContext } from "../src/utils/request-context.js";
import { hasAcceptedServiceTerms, setLinkedAccount } from "../src/utils/session-state.js";
import { saveTransactionPin } from "../src/utils/pin-store.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PHONE = "+2349990001111";
let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ✅ ${name}${extra ? " — " + extra : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
}

async function cleanup() {
  await pool.query(`DELETE FROM customer_sessions WHERE phone = $1`, [PHONE]).catch(() => {});
  await pool.query(`DELETE FROM otp_records WHERE phone = $1`, [PHONE]).catch(() => {});
  await pool.query(`DELETE FROM customer_pins WHERE phone = $1`, [PHONE]).catch(() => {});
  await pool.query(`DELETE FROM verified_customers WHERE phone_number = $1`, [PHONE]).catch(() => {});
}

async function main() {
  await cleanup();

  console.log("\n=== 1. lookup_customer_by_phone (DB-only) ===");
  const notFound = await callBankingTool<{ found: boolean }>("lookup_customer_by_phone", { phone: PHONE });
  check("unknown phone → found=false", notFound?.found === false);

  await pool.query(
    `INSERT INTO customer_sessions (phone, customer_name, account_number, kyc_status, state, context)
     VALUES ($1, 'Test User', '1234567899', 'tier1', 'idle', '{}'::jsonb)`,
    [PHONE]
  );
  await pool.query(
    `INSERT INTO verified_customers (flow_id, flow_token, account_number, bank_code, phone_number)
     VALUES ('f', 't', '1234567899', '058', $1)`,
    [PHONE]
  );
  const found = await callBankingTool<{ found: boolean; is_validated: boolean; has_pin: boolean }>(
    "lookup_customer_by_phone", { phone: PHONE }
  );
  check("session row → found=true", found?.found === true);
  check("verified_customers join → is_validated=true", found?.is_validated === true);
  check("no pin yet → has_pin=false", found?.has_pin === false);

  console.log("\n=== 2. onboarding status / update (DB-only) ===");
  const before = await callBankingTool<{ terms_accepted: boolean }>("get_onboarding_status", { phone: PHONE });
  check("terms_accepted=false initially", before?.terms_accepted === false);
  const upd = await callBankingTool<{ success: boolean }>("update_onboarding_status", {
    phone: PHONE, field: "terms_accepted", value: true,
  });
  check("update_onboarding_status succeeds", upd?.success === true);
  check("hasAcceptedServiceTerms flips true", (await hasAcceptedServiceTerms(PHONE)) === true);

  console.log("\n=== 3. OTP send/verify round-trip (DB-only) ===");
  const otpRes = await callBankingTool<{ success: boolean; otp_code?: string }>(
    "send_verification_otp", { phone: PHONE }
  );
  check("send_verification_otp success", otpRes?.success === true);
  const code = otpRes?.otp_code ?? "";
  check("otp code returned for sandbox/dev", /^\d{4,6}$/.test(code), `code=${code}`);
  const badVerify = await callBankingTool<{ success: boolean }>("verify_otp", { phone: PHONE, otp: "000000" });
  check("wrong OTP rejected", badVerify?.success === false);
  const goodVerify = await callBankingTool<{ success: boolean }>("verify_otp", { phone: PHONE, otp: code });
  check("correct OTP accepted", goodVerify?.success === true);
  const replay = await callBankingTool<{ success: boolean }>("verify_otp", { phone: PHONE, otp: code });
  check("OTP replay blocked (used=true)", replay?.success === false);

  console.log("\n=== 4. verify_pin (local vault) ===");
  const saved = await saveTransactionPin(PHONE, "2468");
  check("saveTransactionPin ok", saved === true);
  const badPin = await callBankingTool<{ is_valid: boolean }>("verify_pin", { phone: PHONE, pin: "1111" });
  check("wrong PIN → is_valid=false", badPin?.is_valid === false);
  const goodPin = await callBankingTool<{ is_valid: boolean }>("verify_pin", { phone: PHONE, pin: "2468" });
  check("correct PIN → is_valid=true", goodPin?.is_valid === true);

  console.log("\n=== 5. context-phone resolution (request context) ===");
  await runWithRequestContext(PHONE, async () => {
    const viaCtx = await callBankingTool<{ found: boolean; is_validated: boolean }>(
      "lookup_customer_by_phone", { phone: "{{contextPhone}}" }
    );
    check("{{contextPhone}} placeholder resolves locally", viaCtx?.found === true && viaCtx?.is_validated === true);
  });

  console.log("\n=== 6. mock-bank network tools (soft — sandbox reachability) ===");
  try {
    await setLinkedAccount(PHONE, { accountNumber: "1234567899", maskedAccount: "••••7899", accountType: "savings" });
    const bal = await callBankingTool<Record<string, unknown>>("balance_enquiry", { phone: PHONE });
    check("balance_enquiry returns a payload", bal !== undefined && bal !== null, JSON.stringify(bal).slice(0, 80));
  } catch (e) {
    console.log(`  ⚠️ balance_enquiry network error (soft): ${(e as Error).message}`);
  }
  try {
    const banks = await callBankingTool<{ banks?: unknown[]; success?: boolean }>("get_supported_banks", {});
    check("get_supported_banks returns list", Array.isArray(banks?.banks) ? banks.banks.length > 0 : banks?.success === true);
  } catch (e) {
    console.log(`  ⚠️ get_supported_banks network error (soft): ${(e as Error).message}`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed (network-soft)`);
  await cleanup();
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  await cleanup();
  await pool.end().catch(() => {});
  process.exit(1);
});
