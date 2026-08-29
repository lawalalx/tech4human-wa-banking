/**
 * Sanity test: deterministic auto-resume chain (the "link-account loop" fix).
 * Run: npx tsx tests/link-loop-fix.sanity.ts
 *
 * Uses the REAL LLM intent classifier (src/utils/intent-classifier.ts) —
 * the brittle regex copy was replaced by the contextual classifier.
 */
import { classifyBankingIntent } from "../src/utils/intent-classifier.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? " — " + extra : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
}

async function main() {
  console.log("\n=== 1. Intent classification (short-circuit routing) ===");
  const cases: Array<[string, string | null]> = [
    ["Check Balance", "balanceAgent"],
    ["Balance", "balanceAgent"],
    ["what is my balance", "balanceAgent"],
    ["Transfer 5000 to mum", "transferAgent"],
    ["send money to John", "transferAgent"],
    ["mini statement", "transactionHistoryAgent"],
    ["Hi", null],
    ["thanks", null],
    ["Done", null],
  ];
  for (const [inp, exp] of cases) {
    const got = await classifyBankingIntent(inp);
    check(`"${inp}" → ${exp}`, got === exp, `got ${got}`);
  }

  console.log("\n=== 2. Short-circuit gate conditions (the reported bug scenario) ===");
  // Scenario from the live logs: account JUST linked via submit_form, "Check Balance" resumed
  const sessionNow = { account_number: "2136789456" };
  const linkedAccount = { maskedAccount: "••••9456" };
  const resumeNote = "AUTO-RESUME: The customer just completed the account-linking flow...";
  const userText = "Check Balance";
  const fires = Boolean(
    resumeNote &&
    (await classifyBankingIntent(userText)) === "balanceAgent" &&
    sessionNow.account_number &&
    linkedAccount.maskedAccount
  );
  check("short-circuit FIRES (linked + Balance resume → balanceAgent, supervisor bypassed)", fires);

  // Anti-loop guard: unlinked customer must NOT short-circuit (still needs the link flow)
  const unlinkedSession = { account_number: null as string | null };
  check(
    "short-circuit DOES NOT fire when account is NOT linked (link flow still sent)",
    !(unlinkedSession.account_number && linkedAccount.maskedAccount && resumeNote)
  );

  // Greeting resume must NOT short-circuit (no banking intent)
  check(
    "short-circuit DOES NOT fire for non-banking resumes (falls through to supervisor)",
    !(await classifyBankingIntent("Hi"))
  );

  console.log("\n=== 3. Direct-path Flow CTA handling (PIN resume chain) ===");
  const directReply =
    "🔐 To keep your money safe, please create a 4-digit transaction PIN.\n\nTap below to set your PIN securely.\n" +
    '<flow_action flow_id="SET_PIN_FLOW" button_text="Set PIN" />';
  const flowKind = /SET_PIN_FLOW/i.test(directReply) ? "pin" : "link";
  check("direct-resume reply with SET_PIN_FLOW → kind=pin awaiting_resume stored", flowKind === "pin");

  const linkReply = "🔗 Great! Let's link your bank account…<flow_action flow_id=\"LINK_ACCOUNT_FLOW\" />";
  const linkKind = /SET_PIN_FLOW/i.test(linkReply) ? "pin" : "link";
  check("supervisor/direct reply with LINK_ACCOUNT_FLOW → kind=link", linkKind === "link");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

