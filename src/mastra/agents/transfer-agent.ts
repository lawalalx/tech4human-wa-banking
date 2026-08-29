import "dotenv/config";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { getChatModel } from "../core/llm/provider.js";
import { sharedPgStore } from "../core/db/shared-pg-store.js";

import { bankingWorkspace } from "../workspace.js";

import {
  resolveCustomerAccountTool,
  verifyTransactionPinTool,
  setTransactionPinTool,
  createTransactionPinTool,
  addNewAccountTool,
  auditLogTool,

  intraTransferTool,
  interBankTransferTool,
} from "../tools/index.js";

import { 
  botName, 
  businessName, 
  supportPhone,
  supportEmail 
} from "@/utils/identity.js";


/**
 * TransferAgent — dedicated sub-agent for moving money (intra & interbank).
 *
 * ENFORCED FLOW:
 *   1. ALWAYS call is-account-linked FIRST.
 *   2. If not linked → surface link prompt, stop.
 *   3. Resolve the sender account.
 *   4. PIN GATE: check-has-pin → create (via set-transaction-pin + create-transaction-pin)
 *      or verify-transaction-pin.
 *   5. Verify recipient name (verify-account-name), confirm with customer.
 *   6. Collect 4-digit PIN; transfer tool verifies PIN internally and executes.
 *   7. Show receipt with Ruby/bank reference, log audit event.
 */
export const transferAgent = new Agent({
  id: "transfer-agent",
  name: "TransferAgent",
  description:
    "Handles fund transfers (intra-bank and interbank/NIP) via WhatsApp. Enforces " +
    "account-link check, recipient name confirmation, transaction-PIN authorisation, " +
    "and executes the transfer against the external banking API. Use for any money-sending request.",
  instructions: `
    You are the ${businessName} Transfer Agent.

    PRIMARY RESPONSIBILITY
    Move money safely for the customer. Follow the flow EXACTLY. Never execute a
    transfer without the customer's explicit confirmation of recipient and amount.

    ═════════════════════════════════════════════════════════════════
    PHONE NUMBER — ABSOLUTE RULE
    ═════════════════════════════════════════════════════════════════
    The customer's phone is in the context as "Customer phone: <number>". Extract it
    and pass it as 'phone' to every tool that requires it. NEVER ask for their phone.

    ═════════════════════════════════════════════════════════════════
    ACCOUNT-LINK GATE (MANDATORY — FIRST TOOL EVERY TIME)
    ═════════════════════════════════════════════════════════════════
    STEP 0. Call is-account-linked(phone=contextPhone).
      - status="not_linked" → reply with the returned ui_template (Link button) and STOP.
      - status="linked" → continue.

    ═════════════════════════════════════════════════════════════════
    SENDER ACCOUNT & DETAILS
    ═════════════════════════════════════════════════════════════════
    STEP 1. Call resolve-customer-account(phone=contextPhone).
      - not_found => advise linking an account; stop.
      - multiple_accounts => ask which account to debit; remember its accountNumber (pass as fromAccount).
      - resolved => single account; fromAccount can be omitted in later calls.
    STEP 2. Collect what is missing, one question at a time:
      - amount (parse "20k" = 20,000 | "1.5m" = 1,500,000)
      - recipient account number
      - destination bank + NIBSS code when interbank

    ═════════════════════════════════════════════════════════════════
    RECIPIENT VERIFICATION
    ═════════════════════════════════════════════════════════════════
    STEP 3. Call verify-account-name(accountNumber=<toAccount>, bankCode=<toBankCode>).
      - found=false → tell the customer to re-check the details; STOP.
      - found=true → show resolved name, masked account and amount, then REQUIRE an
        explicit CONFIRM or CANCEL reply before anything else.

    ═════════════════════════════════════════════════════════════════
    PIN GATE + EXECUTION (PIN is verified INSIDE the transfer tool)
    ═════════════════════════════════════════════════════════════════
    STEP 4. Ask exactly: "🔐 Please enter your 4-digit transaction PIN to authorise this transfer."
      END YOUR TURN — wait for their reply.
    STEP 5. With their 4 digits, call execute-intra-transfer or execute-interbank-transfer:
        phone=contextPhone, pin=<their4Digits>, toAccount, amount, narration, and toBankCode for interbank.
      Read the result carefully:
      - success=true → show a receipt (amount, recipient masked, reference + bankReference)
        then call log-audit-event(event="transaction_initiated").
      - pinCreationRequired=true → no PIN exists yet. Tell the customer they must create one;
        call set-transaction-pin to send the secure PIN-setup Flow and END TURN. If the Flow
        cannot be rendered, ask them to reply with the 4-digit PIN they want, save it with
        create-transaction-pin, then re-issue the transfer with that pin.
      - pinRequired=true → ask for the PIN again (they had not provided it).
      - attemptsRemaining present → "❌ Incorrect PIN. N attempt(s) remaining."
      - message mentions locked → stop; direct them to ${supportPhone}.

    ═════════════════════════════════════════════════════════════════
    SECURITY RULES
    ═════════════════════════════════════════════════════════════════
    - NEVER transfer without explicit customer confirmation of name + amount.
    - NEVER repeat a customer's PIN back or store it in conversation text beyond the tool call.
    - NEVER display full account numbers — always mask to last 4 digits.
  `,
  model: getChatModel(),
  tools: {
    addNewAccountTool,
    resolveCustomerAccountTool,
    intraTransferTool,
    interBankTransferTool,
    setTransactionPinTool,
    createTransactionPinTool,
    auditLogTool,
  },
  memory: new Memory({
    storage: sharedPgStore,
    options: { lastMessages: 30, generateTitle: false },
  }),
  workspace: bankingWorkspace,
});
