/**
 * Sanity test: contextual (LLM) intent classification.
 * Run: npx tsx tests/intent-classifier.sanity.ts
 *
 * Validates the replacements for the brittle customer-text regexes:
 *   1. isFlowDonePhrase      — flow-completion phrasings (was FLOW_DONE_RE)
 *   2. classifyBankingIntent — sub-agent routing (was classifyResumedIntent)
 *   3. classifyInsightsIntent — insights-workflow intent (was inline regexes)
 */
import { isFlowDonePhrase, classifyBankingIntent, classifyInsightsIntent } from "../src/utils/intent-classifier.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? " — " + extra : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
}

async function main() {
  console.log("\n=== 1. Flow-completion phrasings (isFlowDonePhrase) ===");
  const doneCases: Array<[string, boolean]> = [
    // classic
    ["Done", true], ["done.", true], ["I'm done", true], ["finished", true],
    ["I have linked it", true], ["I've completed the flow", true], ["linked", true],
    // the phrasings that BROKE the old anchored regex — must now pass
    ["all set", true], ["All set!", true], ["we good", true], ["that's all", true],
    ["thats all thanks", true], ["I am through with the form", true], ["sorted", true],
    ["it is submitted", true], ["okay I have filled it", true], ["yep done 👍", true],
    // non-completions must stay false
    ["Check Balance", false], ["Transfer 5000", false], ["Hi", false], ["what is my balance?", false],
  ];
  for (const [text, expected] of doneCases) {
    const got = await isFlowDonePhrase(text);
    check(`"${text}" → ${expected}`, got === expected, `got ${got}`);
  }

  console.log("\n=== 2. Banking intent routing (classifyBankingIntent) ===");
  const intentCases: Array<[string, string | null]> = [
    ["Check Balance", "balanceAgent"],
    ["what do I have left in my account", "balanceAgent"],
    ["Transfer 5000 to mum", "transferAgent"],
    ["move 5k to John", "transferAgent"],
    ["mini statement", "transactionHistoryAgent"],
    ["show my recent transactions", "transactionHistoryAgent"],
    ["Hi", null],
    ["thanks", null],
  ];
  for (const [text, expected] of intentCases) {
    const got = await classifyBankingIntent(text);
    check(`"${text}" → ${expected}`, got === expected, `got ${got}`);
  }

  console.log("\n=== 3. Insights intent (classifyInsightsIntent) ===");
  const insightsCases: Array<[string, string]> = [
    ["what's my credit score", "credit_score"],
    ["set a budget of 50k for food", "set_budget"],
    ["show me a chart of my spending", "chart"],
    ["how am I doing with money this month", "spending"],
    ["Hi there", "unknown"],
  ];
  for (const [text, expected] of insightsCases) {
    const got = await classifyInsightsIntent(text);
    check(`"${text}" → ${expected}`, got === expected, `got ${got}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
