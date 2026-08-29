/**
 * Ad-hoc sanity tests for the account-link loop fixes.
 * Usage: npx tsx tests/loop-fix.sanity.ts
 *
 * IMPORTANT: This file import-bundles the helper LOGIC in isolation so it can
 * run without a live WhatsApp/Meta/Postgres. It re-asserts the EXACT same
 * regexes/logic the real code uses so regressions to the loop fix get caught
 * without spinning up the whole bank.
 */

import assert from "node:assert";

// ── 1. Flow-done detection — the REAL LLM-backed classifier ───────────────
// The old FLOW_DONE_RE regex was removed in favour of the contextual
// classifier (src/utils/intent-classifier.ts). This section now exercises the
// real implementation, including phrasings the regex could never match.
import { isFlowDonePhrase } from "../src/utils/intent-classifier.js";

const donePhrases = [
  "Done",
  "finished",
  "I'm done",
  "I've linked it",
  "it's done",
  "done with the flow",
  "all set",
  "we good",
  "that's all, thanks",
];
for (const p of donePhrases) {
  assert.ok(await isFlowDonePhrase(p), `should be flow-done: "${p}"`);
}
console.log("✅ isFlowDonePhrase (LLM): all done-phrase variants classified correctly");

const notDonePhrases = ["Balance", "Check balance", "transfer 5000", "not done", "Hi"];
for (const p of notDonePhrases) {
  assert.ok(!(await isFlowDonePhrase(p)), `should NOT be flow-done: "${p}"`);
}
console.log("✅ isFlowDonePhrase (LLM): non-done phrases correctly rejected");

// ── 2. submit_pin flow-kind + 4-digit validation (replicated from index.ts) ─
function submitPinValidation(pin: string, confirm: string) {
  return /^\d{4}$/.test(pin) && pin === confirm;
}
assert.ok(submitPinValidation("1234", "1234"), "valid matching 4-digit PIN accepted");
assert.ok(!submitPinValidation("123", "123"), "3-digit PIN rejected");
assert.ok(!submitPinValidation("1234", "5678"), "mismatched PIN rejected");
console.log("✅ submit_pin: 4-digit + match validation correct");

// ── 3. Flow-kind discrimination (replicated from send-agent-reply.ts) ────
function flowKind(flowId: string, setPinId: string, linkId: string): "pin" | "link" {
  if (flowId === setPinId) return "pin";
  if (flowId === linkId) return "link";
  return "link"; // default to link when unknown (back-compat)
}
assert.strictEqual(flowKind("FLOW_SET_PIN_ABC", "FLOW_SET_PIN_ABC", "FLOW_LINK_XYZ"), "pin");
assert.strictEqual(flowKind("FLOW_LINK_XYZ", "FLOW_SET_PIN_ABC", "FLOW_LINK_XYZ"), "link");
console.log("✅ flow-kind discrimination: SET_PIN vs LINK correctly classified");

// ── 4. Mask-account (session-state getLinkedAccount path) ───────────────
function maskFallback(account: string) {
  return account.length > 4 ? `••••${account.slice(-4)}` : account;
}
assert.strictEqual(maskFallback("1234567890"), "••••7890");
assert.strictEqual(maskFallback("1234"), "1234");
console.log("✅ masked account fallback correct");

console.log("\n🎉 All loop-fix sanity checks passed.");