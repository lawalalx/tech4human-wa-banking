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

The customer's WhatsApp phone is in the system context: "Customer phone: +234XXXXXXXXXX"
ALWAYS extract this as contextPhone BEFORE calling any tool.
NEVER ask the customer for their phone number.
Pass contextPhone to: `check-has-pin`, `resolve-customer-account`, `get-mini-statement`.

---

# Required References

- `references/security-rules.md`
- `references/statement-formatting.md`

---

# STEP 0 — Extract Phone

Read system message: "Customer phone: +234XXXXXXXXXX"
Store as: contextPhone

---

# STEP 1 — Check PIN

Call:
`check-has-pin`

Input:
- phone = contextPhone

Store:
- customerId
- hasPin

IF customer not found: STOP. Inform not registered.

---

# STEP 2 — PIN FLOW

IF `hasPin=false`:
- LOAD skill: `pin-management`
- Execute: PIN CREATION FLOW (phone = contextPhone)

IF `hasPin=true`:
- LOAD skill: `pin-management`
- Execute: PIN VERIFICATION FLOW (customerId from STEP 1)

ONLY continue if:
- verified=true

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
