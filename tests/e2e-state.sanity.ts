/**
 * End-to-end state-management test for the account-linking / PIN flow.
 * Requires the local Postgres (DATABASE_URL in .env) to be up and migrated.
 * Usage: npx tsx tests/e2e-state.sanity.ts
 *
 * Uses an isolated test phone so it never touches real customer data.
 */
import "dotenv/config";
import assert from "node:assert";
import { Pool } from "pg";

import {
  setAwaitingResume,
  popAwaitingResume,
  setLinkedAccount,
  getLinkedAccount,
  setAutoResumeNote,
  popAutoResumeNote,
  markFlowAutoResumed,
  wasRecentlyAutoResumed,
} from "../src/utils/session-state.js";
import { saveTransactionPin, hasTransactionPin } from "../src/utils/pin-store.js";
import { isFlowDonePhrase, buildAutoResumeNote } from "../src/handlers/chat-handler.js";

const TEST_PHONE = `+23481${String(Math.floor(1000000 + Math.random() * 8999999))}`;
const TEST_ACCOUNT = "12345" + String(Math.floor(10000 + Math.random() * 89999));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function cleanup() {
  try {
    await pool.query(`DELETE FROM customer_pins WHERE phone = $1`, [TEST_PHONE]);
    await pool.query(`DELETE FROM customer_sessions WHERE phone = $1`, [TEST_PHONE]);
  } catch {
    /* ignore cleanup failures in test */
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main() {
  console.log(`Using test phone ${TEST_PHONE}, account ${TEST_ACCOUNT}`);

  // ── 1. Link flow: store awaiting-resume for a "Balance" request ──────────
  await setAwaitingResume(TEST_PHONE, "link", "Balance");
  let resume = await popAwaitingResume(TEST_PHONE);
  assert.ok(resume, "awaiting_resume should be stored");
  assert.strictEqual(resume!.kind, "link");
  assert.strictEqual(resume!.originalRequest, "Balance");
  console.log("✅ set/pop awaiting-resume (link / 'Balance')");

  // After pop, the marker is gone → second pop returns null
  resume = await popAwaitingResume(TEST_PHONE);
  assert.strictEqual(resume, null, "awaiting_resume should be cleared after pop");
  console.log("✅ awaiting-resume clears after pop");

  // ── 2. Simulate submit_form: link the account ────────────────────────────
  await setLinkedAccount(TEST_PHONE, {
    accountNumber: TEST_ACCOUNT,
    maskedAccount: `********${TEST_ACCOUNT.slice(-4)}`,
    accountType: "current",
  });
  const linked = await getLinkedAccount(TEST_PHONE);
  assert.ok(linked, "account should be linked");
  assert.strictEqual(linked!.accountNumber, TEST_ACCOUNT);
  assert.strictEqual(linked!.maskedAccount, `********${TEST_ACCOUNT.slice(-4)}`);
  console.log("✅ setLinkedAccount + getLinkedAccount round-trip");

  // ── 3. Simulate submit_pin: save a 4-digit PIN ───────────────────────────
  const pinSaved = await saveTransactionPin(TEST_PHONE, "1234");
  assert.strictEqual(pinSaved, true);
  assert.strictEqual(await hasTransactionPin(TEST_PHONE), true);
  console.log("✅ saveTransactionPin + hasTransactionPin");
  // The whole point: now the engine will NOT report pinCreationRequired.
  const pinStillSet = await hasTransactionPin(TEST_PHONE);
  assert.strictEqual(pinStillSet, true);
  console.log("✅ PIN persists — pinCreationRequired loop is broken");

  // ── 4. Data-exchange auto-resume fallback primitives ─────────────────────
  await setAutoResumeNote(TEST_PHONE, buildAutoResumeNote("link", "Balance"));
  const note = await popAutoResumeNote(TEST_PHONE);
  assert.strictEqual(note, buildAutoResumeNote("link", "Balance"));
  console.log("✅ set/pop auto_resume_note");

  await markFlowAutoResumed(TEST_PHONE);
  assert.strictEqual(await wasRecentlyAutoResumed(TEST_PHONE, 60_000), true);
  console.log("✅ markFlowAutoResumed + wasRecentlyAutoResumed");

  // ── 5. Pure helpers ──────────────────────────────────────────────────────
  // isFlowDonePhrase is async (LLM-backed contextual classifier) — must await.
  assert.ok(await isFlowDonePhrase("Done"), "Done is a flow-done phrase");
  assert.ok(!(await isFlowDonePhrase("Check balance")), "Check balance is NOT a flow-done phrase");
  const noteText = buildAutoResumeNote("pin", "Transfer 1000");
  assert.ok(noteText.includes("transaction-PIN setup"), "pin note is step-aware");
  assert.ok(noteText.includes('"Transfer 1000"'), "note carries the original request");
  console.log("✅ pure helpers (isFlowDonePhrase / buildAutoResumeNote)");

  console.log("\n🎉 E2E state-management sanity checks passed for", TEST_PHONE);
}

main()
  .then(() => cleanup())
  .catch(async (err) => {
    console.error("❌ E2E test failed:", err);
    await cleanup().catch(() => {});
    process.exit(1);
  });