---
name: mini-statement
description: Retrieves and formats last 10 customer transactions securely with masked account details and WhatsApp-safe formatting.
version: 1.0.0
tags:
  - banking
  - statement
  - transactions
  - history
---

# Mini Statement Skill

This skill returns the customer's last transactions.

THIS IS A READ-ONLY FINANCIAL FLOW.

DO NOT:
- expose full account numbers
- expose internal transaction IDs
- modify data
- skip authentication
- return raw DB output

---

# ⚠️ PHONE NUMBER RULE (ABSOLUTE — READ FIRST)

The customer's phone is always provided in a message as: "Customer phone: [actual number]"
This appears EITHER in the system context OR in the first line of the task message.
Scan ALL messages for a line starting with "Customer phone: " and extract the actual number.

ALWAYS extract this phone before calling ANY tool.
NEVER ask the customer to provide their phone number.
NEVER use a placeholder like "+234XXXXXXXXXX" — only use the real number from the message.
Pass this phone to: `check-has-pin`, `resolve-customer-account`, `get-mini-statement`.

---

# Required References

- `references/security-rules.md`
- `references/statement-formatting.md`

---

# STEP 0 — Extract Phone

Look through all messages in context for a line that starts with "Customer phone: "
followed by an actual phone number (starts with "+" and Nigeria country code 234).
Extract that phone number and store it as contextPhone.

Example: a message saying "Customer phone: +2349013360717" → contextPhone = +2349013360717

CRITICAL: the placeholder "+234XXXXXXXXXX" you see in some instruction templates is NOT a real phone.
Only use the actual number from the message.
NEVER ask the customer for their phone.
NEVER proceed without contextPhone.

---

# STEP 1 — Check PIN

Call:
`check-has-pin`

Input:
- phone = contextPhone

Store:
- hasPin

IF customer not found: STOP. Inform not registered.

---

# STEP 2 — PIN GATE (MANDATORY — THIS STEP ENDS YOUR TURN)

⚠️ DO NOT CALL get-mini-statement in this step. DO NOT continue to STEP 3.

IF `hasPin=false`:
- Send: "To view your mini statement, please create a 4-digit PIN first."
- Execute PIN CREATION FLOW via pin-management skill (phone = contextPhone)
- After PIN created: continue to STEP 3.

IF `hasPin=true`:
- Send EXACTLY this message to the customer and STOP:
  "🔐 Please enter your 4-digit transaction PIN to view your transactions."
- END YOUR RESPONSE. Wait for the customer's reply.
- DO NOT call get-mini-statement now. Your turn is DONE.

PIN COLLECTION RULE: Keep the PIN prompt active until the customer sends exactly 4 digits.
If the customer sends anything other than 4 digits, re-ask for the PIN without calling any tool.

[PIN TURN — customer sends exactly 4 digits]
- Read those 4 digits from the customer's message.
- Call: `verify-transaction-pin` (phone=contextPhone, pin=those4Digits)
- IF verified=false: "❌ Incorrect PIN. [N] attempt(s) remaining." STOP.
- IF verified=true: continue to STEP 3.

---

# STEP 3 — Get Transactions

Call:
`get-mini-statement`

Input:
- phone = contextPhone

Limit:
- last 10 transactions

---

# STEP 4 — Format Output

Read:
`references/statement-formatting.md`

Format EXACTLY as specified.

---

# OUTPUT RULES

NEVER:
- use tables
- expose full account numbers
- expose transaction IDs
- return JSON
