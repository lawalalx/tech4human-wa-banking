---
name: bill-payment
description: Handles secure bill payments (electricity, DSTV, airtime, data, subscriptions) with mandatory biller validation, PIN verification, OTP authentication, and fraud checks.
version: 1.0.0
tags:
  - banking
  - bills
  - payments
  - security
  - otp
---

# Bill Payment Skill

This skill handles all customer bill payments.

THIS IS A SECURITY-CRITICAL FLOW.

DO NOT:
- skip PIN verification
- skip OTP verification
- bypass biller validation
- execute payment before customer confirmation
- fabricate billers or amounts

STOP immediately if any validation fails.

---

# Required References

Read BEFORE execution:

- `references/security-rules.md`
- `references/biller-rules.md`
- `references/bill-formatting.md`
- `references/otp-rules.md`

---

# STEP 1 — Resolve Customer

Call:
`lookup-customer-by-phone`

Extract:
- customerId

IF invalid:
- STOP immediately

---

# STEP 2 — Check PIN Status

Call:
`check-has-pin`

Store:
- hasPin

---

# STEP 3 — PIN FLOW ROUTING

IF `hasPin=false`:
- LOAD skill: `pin-management`
- Execute: PIN CREATION FLOW
- mark `pinVerified=true`

IF `hasPin=true`:
- LOAD skill: `pin-management`
- Execute: PIN VERIFICATION FLOW
- ONLY continue if `verified=true`
- set `pinVerified=true`

IF pin verification fails:
- STOP immediately

---

# STEP 4 — Validate Biller

Call:
`validate-biller`

Extract:
- billerName
- customerReference
- amountDue

IF invalid:
- STOP immediately

---

# STEP 5 — Customer Confirmation

Show:
- biller
- amount
- customer reference

Ask:
"Should I proceed with this payment?"

IF no explicit confirmation:
- STOP

---

# STEP 6 — OTP FLOW

Call:
`send-phone-verification-otp`

Then:
Call:
`verify-phone-verification-otp`

ONLY continue if:
- verified=true

IF failed:
- STOP

---

# STEP 7 — Execute Payment

Call:
`execute-bill-payment`

Store:
- success=true

---

# STEP 8 — Receipt + Audit

Call:
`generate-receipt`
Call:
`log-audit-event`

---

# RESPONSE RULES

Read:
`references/bill-formatting.md`

NEVER:
- use tables
- expose internal IDs
- expose raw biller data
- return JSON
